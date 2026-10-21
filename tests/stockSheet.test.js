/**
 * Stock export with real data in the field team's sheet layout
 * (GET /admin/stock/reports/export-sheet).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
    FILES,
    api,
    createAdmin,
    createLocations,
    createUserWithPermissions,
    login,
    start,
    stop,
    submissionForm,
    validFields,
    withGpsPhotos
} from "./helpers.js";

const { Brand } = await import("../src/modules/stock/brand.model.js");
const { Product } = await import("../src/modules/stock/product.model.js");

let fx;
let token;
let gold;
let snow;
let idol;

before(async () => {
    await start();
    await createAdmin();
    fx = await createLocations();
    token = await login();
    const [ganzberg, idolBrand] = await Brand.create([
        { name: "GANZBERG", sortOrder: 0, measures: ["cases", "canRings"] },
        { name: "IDOL", sortOrder: 1 }
    ]);
    [gold, snow] = await Product.create([
        { brandId: ganzberg._id, name: "Ganzberg Gold", shortName: "GB Gold", sortOrder: 0 },
        { brandId: ganzberg._id, name: "Ganzberg Snow", shortName: "GB Snow", sortOrder: 1 }
    ]);
    idol = await Product.create({ brandId: idolBrand._id, name: "IDOL", shortName: "Idol" });

    const outlet = async (clientName, location, items) => {
        const form = withGpsPhotos(
            submissionForm(
                validFields(fx, { clientName, ...location, stockItems: items ? JSON.stringify(items) : undefined }),
                []
            ),
            [["shop.png", FILES.png()]]
        );
        const res = await api("/public/submissions", { method: "POST", form });
        assert.equal(res.status, 201, JSON.stringify(res.body));
    };
    const p1 = { provinceId: fx.p1._id, districtId: fx.d1._id, communeId: fx.c1._id };
    const p2 = { provinceId: fx.p2._id, districtId: fx.d2._id, communeId: fx.c2._id };
    await outlet("Shop One", p1, [
        { productId: gold._id.toString(), cases: 141, canRings: 3 },
        { productId: snow._id.toString(), cases: 0 },
        { productId: idol._id.toString(), cases: 25 }
    ]);
    await outlet("Shop Two", p2, [{ productId: snow._id.toString(), cases: 338 }]);
    await outlet("No Stock Shop", p1, null);
});
after(stop);

const load = async (query = "") => {
    const res = await api(`/admin/stock/reports/export-sheet${query}`, { token });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /stock-sheet-\d{4}-\d{2}-\d{2}\.xlsx/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    return workbook;
};

const findRow = (sheet, name) => {
    for (let r = 4; r <= sheet.rowCount; r++) if (sheet.getRow(r).getCell("B").value === name) return sheet.getRow(r);
    return null;
};

describe("stock sheet export (real data, field team layout)", () => {
    test("one sheet; title shows the province and district, or All when the rows cover several", async () => {
        const all = await load();
        assert.equal(all.worksheets.length, 1);
        const sheet = all.worksheets[0];
        assert.equal(sheet.getCell("A1").value, "ខេត្ត");
        assert.equal(sheet.getCell("B1").value, "ទាំងអស់ (All)");
        assert.equal(sheet.getCell("H1").value, "ស្រុក/ខណ្ឌ");
        assert.equal(sheet.getCell("J1").value, "ទាំងអស់ (All)");

        const one = (await load(`?provinceId=${fx.p1._id}`)).worksheets[0];
        assert.equal(one.getCell("B1").value, fx.p1.nameKh);
        assert.equal(one.getCell("J1").value, fx.d1.nameKh);
    });

    test("two-row header with merged cells; Province and District columns", async () => {
        const sheet = (await load()).worksheets[0];
        assert.equal(sheet.getCell("A2").value, "ល.រ");
        assert.equal(sheet.getCell("A3").master.address, "A2");
        assert.match(sheet.getCell("B2").value, /Outlet Name/);
        assert.match(sheet.getCell("C2").value, /^ខេត្ត\nProvince$/);
        assert.match(sheet.getCell("D2").value, /^ស្រុក\/ខណ្ឌ\nDistrict$/);
        assert.match(sheet.getCell("E2").value, /ឃុំ\/សង្កាត់/);
        assert.match(sheet.getCell("F2").value, /Telephone/);
        // GB-GOLD NCP: old and new price, then cases and cans under one merged title
        assert.equal(sheet.getCell("G2").value, "តំលៃចាស់");
        assert.equal(sheet.getCell("H2").value, "តំលៃថ្មី");
        assert.equal(sheet.getCell("G3").value, "ឈុត");
        assert.equal(sheet.getCell("I2").value, "GB-GOLD NCP");
        assert.equal(sheet.getCell("J2").master.address, "I2");
        assert.match(sheet.getCell("I3").value, /Stock Count\n\(កេស\)/);
        assert.match(sheet.getCell("J3").value, /\(កំប៉ុង\)/);
        const titles = [];
        for (let c = 1; c <= sheet.columnCount; c++) {
            const cell = sheet.getRow(2).getCell(c);
            if (cell.master.address === cell.address && cell.value) titles.push(cell.value);
        }
        assert.deepEqual(titles.slice(6), [
            "តំលៃចាស់", "តំលៃថ្មី", "GB-GOLD NCP",
            "តំលៃចាស់", "តំលៃថ្មី", "GB-Snow NCP",
            "GB-Gold Wedding",
            "GB-Snow Wedding",
            "តំលៃចាស់", "តំលៃថ្មី", "Boostrong Power",
            "តំលៃចាស់", "តំលៃថ្មី", "Boostrong",
            "តំលៃចាស់", "តំលៃថ្មី", "IDOL"
        ]);
        assert.equal(sheet.columnCount, 30); // A..AD
        // Filter arrows on the header, so Province and District can be filtered
        const filter = sheet.autoFilter;
        assert.match(typeof filter === "string" ? filter : String(filter?.from), /^A3/);
    });

    test("rows: real cases, cans and prices empty, price dropdown, 0 as -", async () => {
        const sheet = (await load()).worksheets[0];
        const one = findRow(sheet, "Shop One");
        const two = findRow(sheet, "Shop Two");
        const noStock = findRow(sheet, "No Stock Shop");
        assert.ok(one && two && noStock);
        assert.equal(one.getCell("C").value, fx.p1.nameKh);
        assert.equal(one.getCell("D").value, fx.d1.nameKh);
        assert.equal(one.getCell("E").value, fx.c1.nameKh);
        assert.equal(one.getCell("F").value, "012345678");
        assert.equal(one.getCell("I").value, 141); // GB-GOLD NCP cases
        assert.equal(one.getCell("J").value, null); // cans: not recorded
        assert.equal(one.getCell("M").value, 0); // GB-Snow NCP cases, shown as "-"
        assert.match(one.getCell("M").numFmt, /"-"/);
        assert.equal(one.getCell("AC").value, 25); // IDOL cases
        assert.equal(two.getCell("D").value, fx.d2.nameKh);
        assert.equal(two.getCell("M").value, 338);
        assert.equal(noStock.getCell("I").value, 0);
        // Price cells are empty, with the sample prices to choose from
        assert.equal(one.getCell("G").value, null);
        assert.equal(one.getCell("G").dataValidation.type, "list");
        assert.deepEqual(one.getCell("H").dataValidation.formulae, ['"100,200,300,400,500"']);
        assert.equal(one.getCell("I").dataValidation, undefined);
        // Numbered 1..n
        assert.deepEqual([4, 5, 6].map((r) => sheet.getRow(r).getCell("A").value), [1, 2, 3]);
    });

    test("uses the Stock page filters; needs stock.export", async () => {
        const sheet = (await load(`?provinceId=${fx.p2._id}`)).worksheets[0];
        assert.equal(sheet.getRow(4).getCell("B").value, "Shop Two");
        assert.equal(sheet.getRow(5).getCell("B").value, null);

        const viewer = await createUserWithPermissions(["stock.view"]);
        assert.equal((await api("/admin/stock/reports/export-sheet", { token: viewer.token })).status, 403);
    });
});
