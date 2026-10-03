import mongoose from "mongoose";
import config from "../../config/env.js";
import { businessDate } from "../../utils/date.js";
import { Province } from "../location/province.model.js";
import { Submission } from "../submission/submission.model.js";
import { Brand } from "../stock/brand.model.js";
import { logoPath } from "../stock/catalog.service.js";
import { Product } from "../stock/product.model.js";
import { MEASURE_KEYS, measuresOf } from "../stock/stock.constants.js";
import { StockReport } from "../stock/stockReport.model.js";

const toId = (value) => new mongoose.Types.ObjectId(value);

/** Province / district / commune filter; outlets and stock reports use the same fields */
const locationFilter = ({ provinceId, districtId, communeId }) => {
    const filter = {};
    if (provinceId) filter.provinceId = toId(provinceId);
    if (districtId) filter.districtId = toId(districtId);
    if (communeId) filter.communeId = toId(communeId);
    return filter;
};

const dateRange = ({ dateFrom, dateTo }) => {
    if (!dateFrom && !dateTo) return null;
    return { ...(dateFrom && { $gte: dateFrom }), ...(dateTo && { $lte: dateTo }) };
};

/** Start of today in the business time zone (Cambodia), as a UTC instant */
const startOfToday = () => new Date(`${businessDate()}T00:00:00.000${config.utcOffset}`);

/**
 * Dashboard numbers for the chosen location and period:
 *  - todayOutlets: outlets added today (Cambodia time), whatever the period
 *  - totalOutlets: outlets added in the period (all time when no dates)
 *  - products (only with stock.view): one entry per active product, in stock-form
 *    order, with the total of each quantity its brand counts and how many outlets
 *    reported it, from stock reports in the period
 *  - totalStock (only with stock.view): cases of every product added together, and
 *    how many outlets reported any stock in the period
 */
export const getDashboard = async (query, { includeStock }) => {
    const location = locationFilter(query);
    const period = dateRange(query);
    const maxTimeMS = config.queryTimeoutMs;

    const [todayOutlets, totalOutlets, products, stockedOutlets] = await Promise.all([
        Submission.countDocuments({ ...location, submittedAt: { $gte: startOfToday() } }).maxTimeMS(maxTimeMS),
        Submission.countDocuments({ ...location, ...(period && { submittedAt: period }) }).maxTimeMS(maxTimeMS),
        includeStock ? productTotals(location, period, maxTimeMS) : null,
        includeStock
            ? StockReport.countDocuments({
                  ...location,
                  ...(period && { reportedAt: period }),
                  items: { $elemMatch: { $or: MEASURE_KEYS.map((key) => ({ [key]: { $gt: 0 } })) } }
              }).maxTimeMS(maxTimeMS)
            : null
    ]);

    const totalStock = products
        ? { cases: products.reduce((sum, product) => sum + (product.totals.cases ?? 0), 0), outlets: stockedOutlets }
        : null;

    return { todayOutlets, totalOutlets, totalStock, products };
};

const productTotals = async (location, period, maxTimeMS) => {
    const [brands, catalogProducts, sums] = await Promise.all([
        Brand.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
        Product.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
        StockReport.aggregate([
            { $match: { ...location, ...(period && { reportedAt: period }) } },
            { $unwind: "$items" },
            {
                $group: {
                    _id: "$items.productId",
                    ...Object.fromEntries(MEASURE_KEYS.map((key) => [key, { $sum: { $ifNull: [`$items.${key}`, 0] } }])),
                    outlets: { $sum: { $cond: [{ $gt: [{ $add: MEASURE_KEYS.map((k) => ({ $ifNull: [`$items.${k}`, 0] })) }, 0] }, 1, 0] } }
                }
            }
        ]).option({ maxTimeMS })
    ]);

    const sumOf = new Map(sums.map((row) => [row._id.toString(), row]));
    return brands.flatMap((brand) => {
        const measures = measuresOf(brand);
        return catalogProducts
            .filter((product) => product.brandId.equals(brand._id))
            .map((product) => {
                const row = sumOf.get(product._id.toString());
                return {
                    productId: product._id.toString(),
                    name: product.name,
                    shortName: product.shortName || product.name,
                    brandName: brand.name,
                    logoUrl: logoPath(brand),
                    measures,
                    // Only the quantities this brand counts
                    totals: Object.fromEntries(measures.map((key) => [key, row?.[key] ?? 0])),
                    // Outlets that reported some stock of this product
                    outlets: row?.outlets ?? 0
                };
            });
    });
};

/**
 * Stock per province for the stacked bar chart: every active province (plus any
 * inactive one that still has stock in the period), with the cases of every active
 * product and how many outlets were added there. Ordered by total, largest first; provinces with no stock come last, in
 * code order, at 0.
 */
export const getProvinceStock = async ({ dateFrom, dateTo }) => {
    const period = dateRange({ dateFrom, dateTo });
    const maxTimeMS = config.queryTimeoutMs;

    const [allProvinces, brands, catalogProducts, rows, outletRows] = await Promise.all([
        Province.find({ isActive: true }).sort({ code: 1 }).select("nameKh nameEn code").lean(),
        Brand.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
        Product.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
        StockReport.aggregate([
            { $match: { ...(period && { reportedAt: period }) } },
            { $unwind: "$items" },
            {
                $group: {
                    _id: { provinceId: "$provinceId", productId: "$items.productId" },
                    nameKh: { $first: "$provinceNameKh" },
                    nameEn: { $first: "$provinceNameEn" },
                    cases: { $sum: { $ifNull: ["$items.cases", 0] } }
                }
            }
        ]).option({ maxTimeMS }),
        // Outlets added in the period, per province (same count as "Total outlet")
        Submission.aggregate([
            { $match: { ...(period && { submittedAt: period }) } },
            { $group: { _id: "$provinceId", outlets: { $sum: 1 }, nameKh: { $first: "$provinceNameKh" }, nameEn: { $first: "$provinceNameEn" } } }
        ]).option({ maxTimeMS })
    ]);

    // Products in stock-form order (brand order, then product order)
    const products = brands.flatMap((brand) =>
        catalogProducts
            .filter((product) => product.brandId.equals(brand._id))
            .map((product) => ({ id: product._id.toString(), shortName: product.shortName || product.name }))
    );
    const known = new Set(products.map((product) => product.id));

    // Every active province starts at 0, in code order
    const byProvince = new Map(
        allProvinces.map((p, order) => [
            p._id.toString(),
            { id: p._id.toString(), nameKh: p.nameKh, nameEn: p.nameEn ?? "", cases: {}, total: 0, outlets: 0, order }
        ])
    );
    for (const row of rows) {
        const productId = row._id.productId.toString();
        if (!known.has(productId) || !row.cases) continue;
        const provinceId = row._id.provinceId.toString();
        if (!byProvince.has(provinceId)) {
            byProvince.set(provinceId, { id: provinceId, nameKh: row.nameKh, nameEn: row.nameEn ?? "", cases: {}, total: 0, outlets: 0, order: Infinity });
        }
        const province = byProvince.get(provinceId);
        province.cases[productId] = (province.cases[productId] ?? 0) + row.cases;
        province.total += row.cases;
    }

    for (const row of outletRows) {
        const provinceId = row._id.toString();
        const province = byProvince.get(provinceId);
        if (province) province.outlets = row.outlets;
        // An inactive province with outlets but no stock is still listed
        else byProvince.set(provinceId, { id: provinceId, nameKh: row.nameKh, nameEn: row.nameEn ?? "", cases: {}, total: 0, outlets: row.outlets, order: Infinity });
    }

    const provinces = [...byProvince.values()]
        .sort((a, b) => b.total - a.total || a.order - b.order)
        .map(({ order, ...province }) => ({ ...province, cases: products.map((product) => province.cases[product.id] ?? 0) }));

    return { products, provinces };
};
