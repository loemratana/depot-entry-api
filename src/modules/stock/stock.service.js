import ExcelJS from "exceljs";
import mongoose from "mongoose";
import ApiError from "../../utils/ApiError.js";
import { businessDate, toBusinessWallTime } from "../../utils/date.js";
import { buildPagination, escapeRegex, getPagination } from "../../utils/pagination.js";
import { Brand } from "./brand.model.js";
import { Product } from "./product.model.js";
import { MEASURE_KEYS, STOCK_MEASURES, measuresOf } from "./stock.constants.js";
import { StockReport } from "./stockReport.model.js";

const toId = (value) => new mongoose.Types.ObjectId(value);

// ---------- Products ----------

/** Active brands with their active products, in form order */
export const listActiveCatalog = async () => {
    const [brands, products] = await Promise.all([
        Brand.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
        Product.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean()
    ]);
    return brands
        .map((brand) => ({
            id: brand._id.toString(),
            name: brand.name,
            nameKh: brand.nameKh,
            measures: measuresOf(brand),
            products: products
                .filter((product) => product.brandId.equals(brand._id))
                .map((product) => ({ id: product._id.toString(), name: product.name }))
        }))
        .filter((brand) => brand.products.length > 0);
};

// ---------- Create ----------

/**
 * Checks that every product exists and is active, and returns report items with
 * brand/product name snapshots. Quantities a brand does not count must be 0 (or
 * blank). `fieldPrefix` names the request field in errors.
 */
export const buildStockItems = async (inputItems, { fieldPrefix = "items" } = {}) => {
    const products = await Product.find({ _id: { $in: inputItems.map((item) => toId(item.productId)) } }).lean();
    const brands = await Brand.find({ _id: { $in: products.map((p) => p.brandId) } }).lean();
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const brandById = new Map(brands.map((b) => [b._id.toString(), b]));

    const errors = [];
    const items = inputItems.map((item, index) => {
        const product = productById.get(item.productId);
        const brand = product && brandById.get(product.brandId.toString());
        if (!product || !brand) {
            errors.push({ field: `${fieldPrefix}.${index}.productId`, message: "Product not found" });
        } else if (!product.isActive || !brand.isActive) {
            errors.push({ field: `${fieldPrefix}.${index}.productId`, message: `${product.name} is no longer available` });
        }
        const counted = measuresOf(brand);
        for (const key of MEASURE_KEYS) {
            if (!counted.includes(key) && item[key]) {
                errors.push({
                    field: `${fieldPrefix}.${index}.${key}`,
                    message: `${key} is not counted for ${product?.name ?? "this product"}`
                });
            }
        }
        return {
            productId: product?._id,
            brandId: brand?._id,
            brandName: brand?.name,
            productName: product?.name,
            measures: counted,
            ...Object.fromEntries(MEASURE_KEYS.map((key) => [key, counted.includes(key) ? item[key] : 0]))
        };
    });
    if (errors.length) throw ApiError.validation(errors, "Invalid products");
    return items;
};

// ---------- Admin list / details / delete ----------

export const buildStockFilter = ({ search, provinceId, districtId, communeId, outletId, dateFrom, dateTo }) => {
    const filter = {};
    if (provinceId) filter.provinceId = toId(provinceId);
    if (districtId) filter.districtId = toId(districtId);
    if (communeId) filter.communeId = toId(communeId);
    if (outletId) filter.outletId = toId(outletId);
    if (dateFrom || dateTo) {
        filter.reportedAt = {};
        if (dateFrom) filter.reportedAt.$gte = dateFrom;
        if (dateTo) filter.reportedAt.$lte = dateTo;
    }
    if (search) filter.outletName = new RegExp(escapeRegex(search.normalize("NFC")), "i");
    return filter;
};

const SORT = { reportedAt: -1, _id: -1 };

const totalsOf = (items) =>
    Object.fromEntries(MEASURE_KEYS.map((key) => [key, items.reduce((sum, item) => sum + (item[key] ?? 0), 0)]));

const toReport = (doc) => ({
    id: doc._id.toString(),
    outlet: { id: doc.outletId.toString(), name: doc.outletName },
    province: { id: doc.provinceId.toString(), nameKh: doc.provinceNameKh, nameEn: doc.provinceNameEn },
    district: { id: doc.districtId.toString(), nameKh: doc.districtNameKh, nameEn: doc.districtNameEn },
    commune: { id: doc.communeId.toString(), nameKh: doc.communeNameKh, nameEn: doc.communeNameEn },
    items: doc.items.map((item) => ({
        productId: item.productId.toString(),
        brandName: item.brandName,
        productName: item.productName,
        measures: measuresOf(item),
        ...Object.fromEntries(MEASURE_KEYS.map((key) => [key, item[key] ?? 0]))
    })),
    totals: totalsOf(doc.items),
    reportedAt: doc.reportedAt,
    submittedByAdmin: Boolean(doc.submittedBy)
});

export const listStockReports = async (query) => {
    const filter = buildStockFilter(query);
    const { page, limit, skip } = getPagination(query);
    const [docs, total] = await Promise.all([
        StockReport.find(filter).sort(SORT).skip(skip).limit(limit).lean(),
        StockReport.countDocuments(filter)
    ]);
    return { data: docs.map(toReport), pagination: buildPagination({ page, limit, total }) };
};

export const getStockReport = async (id) => {
    const doc = await StockReport.findById(id).lean();
    if (!doc) throw ApiError.notFound("Stock report not found");
    return toReport(doc);
};

export const deleteStockReport = async (id) => {
    const doc = await StockReport.findByIdAndDelete(id).select("_id").lean();
    if (!doc) throw ApiError.notFound("Stock report not found");
};

// ---------- Excel export ----------

export const stockExportFileName = () => `stock-reports-${businessDate()}.xlsx`;

const bilingual = (nameKh, nameEn) => (nameEn && nameEn !== nameKh ? `${nameKh} (${nameEn})` : nameKh);

/**
 * One row per report, one column per product and the quantities its brand counts.
 * Product columns follow the current catalog order; products only found in older
 * reports are appended.
 */
export const streamStockExport = async (query, outputStream) => {
    const catalog = await listActiveCatalog();
    const productColumns = catalog.flatMap((brand) =>
        brand.products.map((product) => ({
            id: product.id,
            label: `${brand.name} · ${product.name}`,
            measures: brand.measures
        }))
    );

    const docs = await StockReport.find(buildStockFilter(query)).sort(SORT).lean();
    const known = new Set(productColumns.map((p) => p.id));
    for (const doc of docs) {
        for (const item of doc.items) {
            const id = item.productId.toString();
            if (!known.has(id)) {
                known.add(id);
                productColumns.push({ id, label: `${item.brandName} · ${item.productName}`, measures: measuresOf(item) });
            }
        }
    }

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: outputStream, useStyles: true });
    workbook.creator = "Outlet Management";
    const sheet = workbook.addWorksheet("Stock Reports", { views: [{ state: "frozen", ySplit: 1 }] });

    sheet.columns = [
        { header: "Outlet", key: "outlet", width: 28 },
        { header: "Province", key: "province", width: 26 },
        { header: "District", key: "district", width: 26 },
        { header: "Commune", key: "commune", width: 26 },
        { header: "Reported At", key: "reportedAt", width: 20, style: { numFmt: "yyyy-mm-dd hh:mm" } },
        ...productColumns.flatMap((product) =>
            STOCK_MEASURES.filter((measure) => product.measures.includes(measure.key)).map((measure) => ({
                header: `${product.label} · ${measure.kh}`,
                key: `${product.id}:${measure.key}`,
                width: 18
            }))
        )
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { wrapText: true, vertical: "middle" };
    sheet.getRow(1).height = 45;
    sheet.getRow(1).commit();

    for (const doc of docs) {
        const row = {
            outlet: doc.outletName,
            province: bilingual(doc.provinceNameKh, doc.provinceNameEn),
            district: bilingual(doc.districtNameKh, doc.districtNameEn),
            commune: bilingual(doc.communeNameKh, doc.communeNameEn),
            // Excel has no time zones; write the business-local wall time
            reportedAt: toBusinessWallTime(doc.reportedAt)
        };
        for (const item of doc.items) {
            for (const key of MEASURE_KEYS) row[`${item.productId}:${key}`] = item[key] ?? 0;
        }
        sheet.addRow(row).commit();
    }

    sheet.commit();
    await workbook.commit();
    return docs.length;
};
