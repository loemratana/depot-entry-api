import ExcelJS from "exceljs";
import config from "../../config/env.js";
import { businessDate } from "../../utils/date.js";
import { nameKey } from "../../utils/names.js";
import { Submission } from "../submission/submission.model.js";
import { Product } from "./product.model.js";
import { stockRowsPipeline, toRowDoc } from "./stock.service.js";

/*
 * Stock export with real data in the layout of the field team's own sheet: a
 * title row with the province and district, then a two-row header where each
 * product has its cases and cans, and some products have old and new price
 * columns. One sheet; Province and District columns can be filtered. Columns
 * the system does not record (cans, prices) are left empty to fill in by hand;
 * the price cells offer a dropdown. The usual stock export is separate and
 * unchanged.
 */

/** Sample prices offered by the price dropdowns */
export const PRICE_CHOICES = [100, 200, 300, 400, 500];

const RED = "FFFF0000";
const YELLOW = "FFFFFF00";
const CYAN = "FF00B0F0";
const WHITE = "FFFFFFFF";
const PEACH = "FFF8CBAD";
const ALL = "ទាំងអស់ (All)";

/**
 * The products in the sheet's order. `names` match the product's short name or
 * name (ignoring case and spacing). `prices` describes the old/new price columns
 * before the product, in the colours of the sample sheet.
 */
const SHEET_PRODUCTS = [
    {
        title: "GB-GOLD NCP",
        names: ["GB Gold", "Ganzberg Gold"],
        color: "FFFFC000",
        prices: { oldHeader: RED, newHeader: "FFFFC000", oldCell: RED, newCell: YELLOW }
    },
    {
        title: "GB-Snow NCP",
        names: ["GB Snow", "Ganzberg Snow"],
        color: "FFDDEBF7",
        prices: { oldHeader: RED, newHeader: "FFDDEBF7", oldCell: RED, newCell: YELLOW }
    },
    { title: "GB-Gold Wedding", names: ["GB Gold Wedding", "ស្រាបៀរហ្គេនបឺគ Gold រោងការ"], color: "FFFFE699" },
    { title: "GB-Snow Wedding", names: ["GB Snow Wedding", "ស្រាបៀរហ្គេនបឺគ Snow រោងការ"], color: "FFBDD7EE" },
    {
        title: "Boostrong Power",
        names: ["BSP+", "BOOSTRONG POWER PLUS"],
        color: "FFFFE699",
        prices: { oldHeader: CYAN, newHeader: CYAN, oldCell: WHITE, newCell: WHITE }
    },
    {
        title: "Boostrong",
        names: ["BSS", "BOOSTRONG SUPER"],
        color: "FF92D050",
        prices: { oldHeader: CYAN, newHeader: CYAN, oldCell: WHITE, newCell: WHITE }
    },
    {
        title: "IDOL",
        names: ["Idol", "IDOL"],
        color: "FFFF0066",
        prices: { oldHeader: CYAN, newHeader: CYAN, oldCell: WHITE, newCell: WHITE }
    }
];

const FIRST_DATA_ROW = 4;
const thin = { style: "thin" };
const dashed = { style: "dashed" };
const headerBorder = { top: thin, left: thin, bottom: thin, right: thin };
const cellBorder = { top: dashed, left: thin, bottom: dashed, right: thin };
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
// 0 shows as "-", like the sample
const QUANTITY_FORMAT = '#,##0;-#,##0;"-"';

export const stockSheetFileName = () => `stock-sheet-${businessDate()}.xlsx`;

const placeName = (kh, en) => kh || en || "";

/** product id → sheet product, matched by short name or name */
const matchProducts = async () => {
    const products = await Product.find({}, { name: 1, shortName: 1 }).lean();
    const byKey = new Map();
    for (const product of products) {
        for (const label of [product.shortName, product.name]) {
            if (label && !byKey.has(nameKey(label))) byKey.set(nameKey(label), product._id.toString());
        }
    }
    return SHEET_PRODUCTS.map((product) => ({
        ...product,
        productId: product.names.map((name) => byKey.get(nameKey(name))).find(Boolean) ?? null
    }));
};

/** Outlet columns (filterable province and district), then per product [old, new] prices and cases, cans */
const buildColumns = (products) => {
    const columns = [
        { key: "no", header: "ល.រ", width: 6 },
        { key: "outlet", header: "ឈ្មោះតូប\nOutlet Name", width: 22 },
        { key: "province", header: "ខេត្ត\nProvince", width: 18 },
        { key: "district", header: "ស្រុក/ខណ្ឌ\nDistrict", width: 20 },
        { key: "commune", header: "ឃុំ/សង្កាត់\nCommune", width: 22 },
        { key: "phone", header: "លេខទូរស័ព្ទ\nTelephone", width: 16 }
    ];
    const groups = [];
    for (const product of products) {
        if (product.prices) {
            columns.push({ key: `${product.title}:old`, price: "old", product, width: 9 });
            columns.push({ key: `${product.title}:new`, price: "new", product, width: 9 });
        }
        const start = columns.length + 1;
        columns.push({ key: `${product.title}:cases`, measure: "cases", product, width: 10 });
        columns.push({ key: `${product.title}:cans`, measure: "cans", product, width: 10 });
        groups.push({ product, start });
    }
    return { columns, groups };
};

const writeHeader = (sheet, { columns, groups }, { provinceName, districtName }) => {
    // Row 1: the province and district shown (All when the rows cover several)
    sheet.getRow(1).height = 30;
    const title = (address, value) => {
        const cell = sheet.getCell(address);
        cell.value = value;
        cell.font = { bold: true, size: 14 };
        cell.alignment = { vertical: "middle" };
    };
    title("A1", "ខេត្ត");
    title("B1", provinceName);
    title("H1", "ស្រុក/ខណ្ឌ");
    title("J1", districtName);

    const row2 = sheet.getRow(2);
    const row3 = sheet.getRow(3);
    row2.height = 24;
    row3.height = 54;
    columns.forEach((column, index) => {
        const col = index + 1;
        sheet.getColumn(col).width = column.width;
        const top = row2.getCell(col);
        const bottom = row3.getCell(col);
        for (const cell of [top, bottom]) {
            cell.border = headerBorder;
            cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
            cell.font = { bold: true };
        }
        if (!column.product) {
            // Outlet columns span both header rows
            top.value = column.header;
            sheet.mergeCells(2, col, 3, col);
        } else if (column.price) {
            const colors = column.product.prices;
            const old = column.price === "old";
            top.value = old ? "តំលៃចាស់" : "តំលៃថ្មី";
            top.fill = fill(old ? colors.oldHeader : colors.newHeader);
            top.font = { bold: true, color: { argb: old && colors.oldHeader === RED ? WHITE : "FF000000" } };
            bottom.value = "ឈុត";
            bottom.fill = fill(old ? colors.oldCell : colors.newCell);
        } else {
            bottom.value = column.measure === "cases" ? "Stock Count\n(កេស)" : "Stock Count\n(កំប៉ុង)";
            bottom.font = { bold: false };
            bottom.fill = fill(PEACH);
        }
    });
    // Product names span their cases and cans columns
    for (const { product, start } of groups) {
        sheet.mergeCells(2, start, 2, start + 1);
        const cell = row2.getCell(start);
        cell.value = product.title;
        cell.fill = fill(product.color);
        cell.font = { bold: true, size: 13, color: { argb: product.color === "FFFF0066" ? WHITE : "FF000000" } };
    }
};

const writeRows = (sheet, columns, rows) => {
    rows.forEach((doc, index) => {
        const quantities = new Map(doc.items.map((item) => [item.productId.toString(), item]));
        const values = columns.map((column) => {
            if (column.key === "no") return index + 1;
            if (column.key === "outlet") return doc.outletName;
            if (column.key === "province") return placeName(doc.provinceNameKh, doc.provinceNameEn);
            if (column.key === "district") return placeName(doc.districtNameKh, doc.districtNameEn);
            if (column.key === "commune") return placeName(doc.communeNameKh, doc.communeNameEn);
            if (column.key === "phone") return doc.phone || "";
            // Cases from the stock report; cans and prices are not recorded (filled in by hand)
            if (column.measure === "cases") return quantities.get(column.product.productId)?.cases ?? 0;
            return null;
        });
        const row = sheet.addRow(values);
        row.height = 22;
        columns.forEach((column, i) => {
            const cell = row.getCell(i + 1);
            cell.border = cellBorder;
            const text = ["outlet", "province", "district", "commune"].includes(column.key);
            cell.alignment = { vertical: "middle", horizontal: text ? "left" : "center" };
            if (column.key === "phone") cell.numFmt = "@";
            if (column.measure) {
                cell.fill = fill(PEACH);
                cell.numFmt = QUANTITY_FORMAT;
            }
            if (column.price) {
                cell.fill = fill(YELLOW);
                cell.dataValidation = {
                    type: "list",
                    allowBlank: true,
                    formulae: [`"${PRICE_CHOICES.join(",")}"`]
                };
            }
        });
    });
};

/** One name when every row shares it, otherwise "All" */
const sharedName = (rows, kh, en) => {
    const names = new Set(rows.map((row) => placeName(row[kh], row[en])));
    return names.size === 1 ? [...names][0] : ALL;
};

/**
 * The stock sheet for the Stock page filters: the same outlets as the Stock
 * list (outlets without stock show "-"), on one sheet ordered by province,
 * district, commune and outlet name.
 */
export const buildStockSheetExport = async (query) => {
    const [products, outlets] = await Promise.all([
        matchProducts(),
        Submission.aggregate(stockRowsPipeline(query)).option({ maxTimeMS: config.exportQueryTimeoutMs })
    ]);
    const layout = buildColumns(products);
    const byName = (a, b) => (a || "").localeCompare(b || "", "km");
    const rows = outlets
        .map(toRowDoc)
        .sort(
            (a, b) =>
                byName(a.provinceNameKh, b.provinceNameKh) ||
                byName(a.districtNameKh, b.districtNameKh) ||
                byName(a.communeNameKh, b.communeNameKh) ||
                byName(a.outletName, b.outletName)
        );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Outlet Management";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Stock", { views: [{ state: "frozen", ySplit: 3 }] });
    writeHeader(sheet, layout, {
        provinceName: rows.length ? sharedName(rows, "provinceNameKh", "provinceNameEn") : "",
        districtName: rows.length ? sharedName(rows, "districtNameKh", "districtNameEn") : ""
    });
    if (rows.length === 0) {
        sheet.getCell(`A${FIRST_DATA_ROW}`).value = "No outlets match the selected filters.";
    }
    writeRows(sheet, layout.columns, rows);
    // Filter arrows on the second header row, like the sample (Province and District included)
    sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + rows.length, column: layout.columns.length } };

    return { workbook, rowCount: rows.length };
};
