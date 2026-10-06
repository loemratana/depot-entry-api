import ExcelJS from "exceljs";
import mongoose from "mongoose";
import config from "../../config/env.js";
import ApiError from "../../utils/ApiError.js";
import { businessDate, toBusinessWallTime } from "../../utils/date.js";
import { buildPagination, escapeRegex, getPagination } from "../../utils/pagination.js";
import {
    DOWNLOAD_CONCURRENCY,
    PHOTO_COLUMN_WIDTH,
    plannedPictureBytes,
    COORDINATES_COLUMN_WIDTH,
    ROW_HEIGHT_POINTS,
    addThumbnail,
    mapWithLimit,
    setCoordinates
} from "../../utils/excel-images.js";
import { isPicture, loadExportPicture } from "../export/exportPicture.service.js";
import { Submission } from "../submission/submission.model.js";
import { Brand } from "./brand.model.js";
import { logoPath } from "./catalog.service.js";
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
            // Relative to /api; null when the brand has no logo
            logoUrl: logoPath(brand),
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
        StockReport.find(filter).sort(SORT).skip(skip).limit(limit).maxTimeMS(config.queryTimeoutMs).lean(),
        StockReport.countDocuments(filter).maxTimeMS(config.queryTimeoutMs)
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

/** Same as the outlet export: up to 5 photos per outlet, one column each */
const MAX_PHOTO_COLUMNS = 5;

/**
 * One row per report: No., outlet and location, one column per product and the
 * quantities its brand counts, the outlet's photos (Photo 1, Photo 2, … like
 * the outlet export), and its GPS coordinates in the last column. Product
 * columns follow the current catalog order; products only found in older
 * reports are appended. Photos are small previews, loaded once per outlet even
 * when it has several reports. They are held in memory until the file is
 * written, so their total size is capped (EXPORT_MAX_IMAGE_MB); past the cap
 * the cell says so.
 */
export const buildStockExport = async (query) => {
    const catalog = await listActiveCatalog();
    const productColumns = catalog.flatMap((brand) =>
        brand.products.map((product) => ({
            id: product.id,
            label: `${brand.name} · ${product.name}`,
            measures: brand.measures
        }))
    );

    const docs = await StockReport.find(buildStockFilter(query))
        .sort(SORT)
        .maxTimeMS(config.exportQueryTimeoutMs)
        .lean();
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

    // The outlets' photos, planned within the memory budget before loading
    const outletIds = [...new Set(docs.map((doc) => doc.outletId.toString()))];
    const outlets = await Submission.find(
        { _id: { $in: outletIds } },
        {
            "files._id": 1,
            "files.objectKey": 1,
            "files.previewKey": 1,
            "files.mimeType": 1,
            "files.size": 1,
            "files.photoId": 1,
            "files.originalName": 1,
            "files.location": 1
        }
    )
        .maxTimeMS(config.exportQueryTimeoutMs)
        .lean();
    const filesOf = new Map(outlets.map((outlet) => [outlet._id.toString(), outlet.files ?? []]));
    // Site photos (taken with GPS on the form) first, then other pictures
    const photosOf = new Map(
        outlets.map((outlet) => {
            const pictures = (outlet.files ?? []).filter(isPicture);
            const ordered = [...pictures.filter((file) => file.photoId), ...pictures.filter((file) => !file.photoId)];
            return [outlet._id.toString(), ordered.slice(0, MAX_PHOTO_COLUMNS)];
        })
    );

    const budget = config.export.maxImageBytes;
    let planned = 0;
    let budgetReached = false;
    const toLoad = []; // { outletId, file }, each outlet's photos loaded once
    for (const id of outletIds) {
        for (const file of photosOf.get(id) ?? []) {
            const size = plannedPictureBytes(file);
            if (planned + size > budget) {
                budgetReached = true;
                continue;
            }
            planned += size;
            toLoad.push({ outletId: id, file });
        }
    }
    const loaded = await mapWithLimit(toLoad, DOWNLOAD_CONCURRENCY, ({ outletId, file }) =>
        loadExportPicture(outletId, file)
    );
    const pictureOf = new Map(toLoad.map(({ file }, index) => [file._id.toString(), loaded[index]]));
    const photoColumns = Math.max(1, ...outletIds.map((id) => photosOf.get(id)?.length ?? 0));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Outlet Management";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Stock Reports", { views: [{ state: "frozen", ySplit: 1 }] });

    sheet.columns = [
        { header: "No.", key: "no", width: 6 },
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
        ),
        ...Array.from({ length: photoColumns }, (_, i) => ({
            header: `Photo ${i + 1}`,
            key: `photo${i + 1}`,
            width: PHOTO_COLUMN_WIDTH
        })),
        { header: "Coordinates", key: "coordinates", width: COORDINATES_COLUMN_WIDTH }
    ];
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.alignment = { wrapText: true, vertical: "middle" };
    header.height = 45;
    // Zero-based index of "Photo 1" for image anchors (the photos sit just before Coordinates)
    const FIRST_PHOTO_COLUMN = sheet.columns.length - 1 - photoColumns;
    // An outlet with several reports shows the same photos; the file holds each once
    const imageIds = new Map();

    docs.forEach((doc, index) => {
        const outletId = doc.outletId.toString();
        const values = {
            no: index + 1,
            outlet: doc.outletName,
            province: bilingual(doc.provinceNameKh, doc.provinceNameEn),
            district: bilingual(doc.districtNameKh, doc.districtNameEn),
            commune: bilingual(doc.communeNameKh, doc.communeNameEn),
            // Excel has no time zones; write the business-local wall time
            reportedAt: toBusinessWallTime(doc.reportedAt)
        };
        for (const item of doc.items) {
            for (const key of MEASURE_KEYS) values[`${item.productId}:${key}`] = item[key] ?? 0;
        }
        const row = sheet.addRow(values);
        row.alignment = { vertical: "middle", wrapText: true };
        row.getCell("no").alignment = { vertical: "middle", horizontal: "center" };
        setCoordinates(row.getCell("coordinates"), filesOf.get(outletId));

        const photos = photosOf.get(outletId) ?? [];
        if (photos.length === 0) row.getCell("photo1").value = "No picture";
        photos.forEach((file, i) => {
            const id = file._id.toString();
            const cell = row.getCell(`photo${i + 1}`);
            if (!pictureOf.has(id)) {
                cell.value = "(not shown: size limit)";
                return;
            }
            const picture = pictureOf.get(id);
            if (!picture) {
                cell.value = "(unavailable)";
                return;
            }
            addThumbnail(workbook, sheet, {
                buffer: picture.buffer,
                mimeType: picture.mimeType,
                col: FIRST_PHOTO_COLUMN + i,
                rowNumber: row.number,
                imageIds
            });
            row.height = ROW_HEIGHT_POINTS;
        });
    });

    sheet.autoFilter = { from: "A1", to: { row: 1, column: sheet.columns.length } };

    if (budgetReached) {
        const note = workbook.addWorksheet("Notes");
        note.getColumn(1).width = 100;
        note.addRow([
            `Some pictures are not shown because this export reached the ${Math.round(budget / 1024 / 1024)} MB ` +
                "image limit. Narrow the filters to export fewer reports."
        ]);
    }

    return { workbook, rowCount: docs.length };
};
