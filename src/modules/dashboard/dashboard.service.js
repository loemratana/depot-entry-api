import mongoose from "mongoose";
import config from "../../config/env.js";
import { businessDate } from "../../utils/date.js";
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
 */
export const getDashboard = async (query, { includeStock }) => {
    const location = locationFilter(query);
    const period = dateRange(query);
    const maxTimeMS = config.queryTimeoutMs;

    const [todayOutlets, totalOutlets, products] = await Promise.all([
        Submission.countDocuments({ ...location, submittedAt: { $gte: startOfToday() } }).maxTimeMS(maxTimeMS),
        Submission.countDocuments({ ...location, ...(period && { submittedAt: period }) }).maxTimeMS(maxTimeMS),
        includeStock ? productTotals(location, period, maxTimeMS) : null
    ]);

    return { todayOutlets, totalOutlets, products };
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
