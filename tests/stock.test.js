import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
    FILES,

    Submission,
    api,
    createAdmin,
    createLocations,
    listBucketKeys,
    login,
    mongoose,
    start,
    stop,
    submissionForm,
    validFields,
    withGpsPhotos
} from "./helpers.js";

const { Brand } = await import("../src/modules/stock/brand.model.js");
const { Product } = await import("../src/modules/stock/product.model.js");
const { StockReport } = await import("../src/modules/stock/stockReport.model.js");
const { default: config } = await import("../src/config/env.js");

let fx;
let token;
let snow;
let gold;
let idol;
let retired;
let weddingGold;
let weddingSnow;

const ALL_MEASURES = ["cases", "canRings", "cashRingsUsd", "cashRingsKhr"];

before(async () => {
    await start();
    await createAdmin();
    fx = await createLocations();
    token = await login();

    const [ganzberg, idolBrand, wedding] = await Brand.create([
        { name: "GANZBERG", nameKh: "ហ្គែនប៊ឺក", sortOrder: 0 },
        { name: "IDOL", sortOrder: 2 },
        // Right after GANZBERG; counts cases only
        { name: "GANZBERG BEER WEDDING", nameKh: "ស្រាបៀរហ្គេនបឺគរោងការ", sortOrder: 1, measures: ["cases"] }
    ]);
    [snow, gold, retired] = await Product.create([
        { brandId: ganzberg._id, name: "Ganzberg Snow", sortOrder: 0 },
        { brandId: ganzberg._id, name: "Ganzberg Gold", sortOrder: 1 },
        { brandId: ganzberg._id, name: "Old Product", sortOrder: 2, isActive: false }
    ]);
    idol = await Product.create({ brandId: idolBrand._id, name: "IDOL" });
    [weddingGold, weddingSnow] = await Product.create([
        { brandId: wedding._id, name: "ស្រាបៀរហ្គេនបឺគ Gold រោងការ", sortOrder: 0 },
        { brandId: wedding._id, name: "ស្រាបៀរហ្គេនបឺគ Snow រោងការ", sortOrder: 1 }
    ]);
});
after(stop);

const stockItems = () => [
    { productId: snow._id.toString(), cases: 3, rings: 12, canRings: "", cashRingsUsd: 1, cashRingsKhr: 4 },
    { productId: gold._id.toString(), cases: "1", canRings: 5 },
    { productId: idol._id.toString() },
    { productId: weddingGold._id.toString(), cases: 7 },
    { productId: weddingSnow._id.toString(), cases: "" }
];

// The outlet form sends stock as a JSON string inside the multipart body
const submitOutlet = (overrides = {}, items = stockItems(), headers) =>
    api("/public/submissions", {
        method: "POST",
        // Each outlet has one site photo with GPS, like the form sends
        form: withGpsPhotos(
            submissionForm(
                validFields(fx, { saleGbId: undefined, ...overrides, stockItems: items === null ? undefined : JSON.stringify(items) }),
                []
            ),
            [["shop.png", FILES.png()]]
        ),
        headers
    });

describe("stock catalog", () => {
    test("lists active brands and products in order, each brand with the quantities it counts", async () => {
        const res = await api("/public/stock/catalog");
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.data.measures.map((m) => m.key), ALL_MEASURES);
        assert.ok(!res.body.data.measures.some((m) => m.key === "kula"), "ចំនួនទឹកលុយគុល្លា was removed");
        assert.ok(!res.body.data.measures.some((m) => m.key === "rings"), "ចំនួនក្រវិល was removed");
        assert.deepEqual(res.body.data.measures.map((m) => m.kh), [
            "ចំនួនកេស",
            "ចំនួនក្រវិលកំប៉ុង",
            "ចំនួនក្រវិលលុយ(ដុល្លា)",
            "ចំនួនក្រវិលលុយ(រៀល)"
        ]);
        assert.deepEqual(
            res.body.data.brands.map((b) => [b.name, b.measures, b.products.map((p) => p.name)]),
            [
                ["GANZBERG", ALL_MEASURES, ["Ganzberg Snow", "Ganzberg Gold"]],
                ["GANZBERG BEER WEDDING", ["cases"], ["ស្រាបៀរហ្គេនបឺគ Gold រោងការ", "ស្រាបៀរហ្គេនបឺគ Snow រោងការ"]],
                ["IDOL", ALL_MEASURES, ["IDOL"]]
            ]
        );
    });

    test("the separate public outlet and report endpoints no longer exist", async () => {
        assert.equal((await api(`/public/stock/outlets?communeId=${fx.c1._id}`)).status, 404);
        assert.equal((await api("/public/stock/reports", { method: "POST", json: {} })).status, 404);
    });
});

describe("stock sent with the outlet form (/submit)", () => {
    test("creates the outlet and its stock report together; blank quantities are 0", async () => {
        const res = await submitOutlet({ clientName: "Shop Alpha" });
        assert.equal(res.status, 201);

        const outlet = await Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
        const report = await StockReport.findOne({ outletId: outlet._id }).lean();
        assert.ok(report, "stock report created");
        assert.equal(report.outletName, "Shop Alpha");
        assert.ok(report.communeId.equals(outlet.communeId));
        assert.equal(report.reportedAt.getTime(), outlet.submittedAt.getTime());
        assert.equal(report.submittedBy, null);
        assert.deepEqual(
            report.items.map((i) => [i.productName, ...ALL_MEASURES.map((key) => i[key])]),
            [
                ["Ganzberg Snow", 3, 0, 1, 4],
                ["Ganzberg Gold", 1, 5, 0, 0],
                ["IDOL", 0, 0, 0, 0],
                ["ស្រាបៀរហ្គេនបឺគ Gold រោងការ", 7, 0, 0, 0],
                ["ស្រាបៀរហ្គេនបឺគ Snow រោងការ", 0, 0, 0, 0]
            ]
        );
        // Which quantities each brand counted is kept with the report
        assert.deepEqual(report.items[0].measures, ALL_MEASURES);
        assert.deepEqual(report.items[3].measures, ["cases"]);
        assert.equal(report.items[0].cans, undefined);
        // Retired quantities sent by an old client (rings: 12 above) are ignored, not stored
        assert.equal(report.items[0].kula, undefined);
        assert.equal(report.items[0].rings, undefined);
    });

    test("stock is optional: an outlet without stock has no report", async () => {
        const res = await submitOutlet({ clientName: "No Stock Shop" }, null);
        assert.equal(res.status, 201);
        const outlet = await Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
        assert.equal(await StockReport.countDocuments({ outletId: outlet._id }), 0);
    });

    test("invalid quantities are rejected before anything is saved or uploaded", async () => {
        const outletsBefore = await Submission.countDocuments();
        const filesBefore = (await listBucketKeys()).length;
        const res = await submitOutlet({ clientName: "Bad Stock" }, [
            { productId: snow._id.toString(), cases: -1 },
            { productId: gold._id.toString(), canRings: 1.5 },
            { productId: idol._id.toString(), cashRingsKhr: "abc" }
        ]);
        assert.equal(res.status, 400);
        assert.deepEqual(res.body.errors.map((e) => e.field).sort(), [
            "stockItems.0.cases",
            "stockItems.1.canRings",
            "stockItems.2.cashRingsKhr"
        ]);
        assert.equal(await Submission.countDocuments(), outletsBefore);
        assert.equal((await listBucketKeys()).length, filesBefore);
    });

    test("a quantity the brand does not count is rejected (wedding beer counts cases only)", async () => {
        const before = await Submission.countDocuments();
        const res = await submitOutlet({ clientName: "Wedding Rings" }, [
            { productId: weddingGold._id.toString(), cases: 2, canRings: 5, cashRingsUsd: 1 }
        ]);
        assert.equal(res.status, 400);
        assert.deepEqual(res.body.errors.map((e) => e.field).sort(), ["stockItems.0.canRings", "stockItems.0.cashRingsUsd"]);
        assert.equal(await Submission.countDocuments(), before);
    });

    test("inactive, unknown and repeated products are rejected; nothing is saved", async () => {
        const before = await Submission.countDocuments();

        const inactive = await submitOutlet({}, [{ productId: retired._id.toString(), cases: 1 }]);
        assert.equal(inactive.status, 400);
        assert.equal(inactive.body.errors[0].field, "stockItems.0.productId");
        assert.match(inactive.body.errors[0].message, /no longer available/);

        const unknown = await submitOutlet({}, [{ productId: new mongoose.Types.ObjectId().toString() }]);
        assert.equal(unknown.body.errors[0].message, "Product not found");

        const repeated = await submitOutlet({}, [{ productId: snow._id.toString() }, { productId: snow._id.toString() }]);
        assert.equal(repeated.status, 400);

        const notJson = await api("/public/submissions", {
            method: "POST",
            form: submissionForm(validFields(fx, { stockItems: "{not json" }))
        });
        assert.equal(notJson.status, 400);

        assert.equal(await Submission.countDocuments(), before);
    });

    test("a replayed request (same Idempotency-Key) does not create a second report", async () => {
        const headers = { "Idempotency-Key": "outlet-stock-key-0001" };
        const reportsBefore = await StockReport.countDocuments();
        const first = await submitOutlet({ clientName: "Replay Shop" }, stockItems(), headers);
        const second = await submitOutlet({ clientName: "Replay Shop" }, stockItems(), headers);
        assert.equal(first.status, 201);
        assert.equal(second.status, 200);
        assert.equal(await StockReport.countDocuments(), reportsBefore + 1);
    });
});

describe("admin stock reports", () => {
    test("list shows reports newest first with totals, and filters work", async () => {
        const res = await api("/admin/stock/reports", { token });
        assert.equal(res.status, 200);
        assert.equal(res.body.pagination.total, 2);
        const alpha = res.body.data.find((r) => r.outlet.name === "Shop Alpha");
        assert.deepEqual(alpha.totals, { cases: 11, canRings: 5, cashRingsUsd: 1, cashRingsKhr: 4 });
        // Product names and the quantities each brand counts come with every report
        assert.deepEqual(alpha.items.map((i) => i.productName), [
            "Ganzberg Snow",
            "Ganzberg Gold",
            "IDOL",
            "ស្រាបៀរហ្គេនបឺគ Gold រោងការ",
            "ស្រាបៀរហ្គេនបឺគ Snow រោងការ"
        ]);
        assert.deepEqual(alpha.items[3].measures, ["cases"]);

        assert.equal((await api(`/admin/stock/reports?provinceId=${fx.p2._id}`, { token })).body.pagination.total, 0);
        assert.equal((await api(`/admin/stock/reports?outletId=${alpha.outlet.id}`, { token })).body.pagination.total, 1);
        assert.equal((await api(`/admin/stock/reports?search=${encodeURIComponent("alpha")}`, { token })).body.pagination.total, 1);
        assert.equal((await api("/admin/stock/reports?dateFrom=2020-01-01&dateTo=2020-01-02", { token })).body.pagination.total, 0);
    });

    test("Excel export: No. first, one column per product and measure, photos last", async () => {
        const res = await api("/admin/stock/reports/export", { token });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-disposition"), /stock-reports-\d{4}-\d{2}-\d{2}\.xlsx/);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(res.body);
        const sheet = workbook.getWorksheet("Stock Reports");
        const headers = sheet.getRow(1).values.slice(1);
        assert.deepEqual(headers.slice(0, 6), ["No.", "Outlet", "Province", "District", "Commune", "Reported At"]);
        assert.ok(headers.includes("GANZBERG · Ganzberg Snow · ចំនួនកេស"));
        assert.ok(headers.includes("GANZBERG · Ganzberg Snow · ចំនួនក្រវិលលុយ(រៀល)"));
        assert.ok(headers.includes("GANZBERG BEER WEDDING · ស្រាបៀរហ្គេនបឺគ Gold រោងការ · ចំនួនកេស"));
        // Wedding beer has a cases column only
        assert.equal(headers.filter((h) => /WEDDING/.test(h)).length, 2);
        assert.equal(headers.filter((h) => /ចំនួនកំប៉ុង|ចំនួនទឹកលុយគុល្លា|· ចំនួនក្រវិល$/.test(h)).length, 0);
        assert.deepEqual(headers.slice(-2), ["Photo 1", "Coordinates"]);
        // Each outlet's site photo has GPS: coordinates link to Google Maps
        assert.equal(sheet.getRow(2).getCell(headers.length).value.text, "11.556400, 104.928200");
        assert.equal(headers.length, 8 + 3 * 4 + 2 * 1);
        assert.equal(sheet.rowCount, 3);

        // Rows are numbered 1..n in the first column
        assert.deepEqual([sheet.getRow(2).getCell(1).value, sheet.getRow(3).getCell(1).value], [1, 2]);
        // Each outlet's photo is embedded in the Photo 1 column (second to last), one per row
        const images = sheet.getImages();
        assert.equal(images.length, 2);
        assert.ok(images.every((image) => image.range.tl.nativeCol === headers.length - 2));
        assert.deepEqual(images.map((image) => image.range.tl.nativeRow).sort(), [1, 2]);
    });

    test("Excel export: no picture, and pictures past the memory limit, are explained in the cell", async () => {
        const load = async () => {
            const res = await api("/admin/stock/reports/export", { token });
            assert.equal(res.status, 200);
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(res.body);
            return workbook;
        };
        const pictureCells = (sheet) =>
            Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2).getCell(sheet.columnCount - 1).value);

        // An outlet whose only file is a PDF has no picture
        const pdfOnly = await api("/public/submissions", {
            method: "POST",
            form: submissionForm(
                validFields(fx, { saleGbId: undefined, clientName: "PDF Only Shop", stockItems: JSON.stringify(stockItems()) }),
                [["doc.pdf", FILES.pdf()]]
            )
        });
        assert.equal(pdfOnly.status, 201, JSON.stringify(pdfOnly.body));
        let sheet = (await load()).getWorksheet("Stock Reports");
        const outletCol = sheet.getRow(1).values.indexOf("Outlet");
        const pdfRow = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2)).find(
            (row) => row.getCell(outletCol).value === "PDF Only Shop"
        );
        assert.equal(pdfRow.getCell(sheet.columnCount - 1).value, "No picture");

        // Past the image limit pictures are not embedded, and a Notes sheet explains why
        const saved = config.export.maxImageBytes;
        config.export.maxImageBytes = 1;
        try {
            const workbook = await load();
            sheet = workbook.getWorksheet("Stock Reports");
            assert.equal(sheet.getImages().length, 0);
            assert.ok(pictureCells(sheet).includes("(not shown: size limit)"));
            assert.match(workbook.getWorksheet("Notes").getCell("A1").value, /image limit/);
        } finally {
            config.export.maxImageBytes = saved;
        }
    });

    test("details and deleting a single report", async () => {
        const replay = (await api(`/admin/stock/reports?search=${encodeURIComponent("Replay")}`, { token })).body.data[0];
        const detail = await api(`/admin/stock/reports/${replay.id}`, { token });
        assert.equal(detail.status, 200);
        assert.equal(detail.body.data.items.length, 5);

        assert.equal((await api(`/admin/stock/reports/${replay.id}`, { method: "DELETE", token })).status, 200);
        assert.equal((await api(`/admin/stock/reports/${replay.id}`, { token })).status, 404);
    });

    test("deleting an outlet also deletes its stock reports", async () => {
        const outlet = await Submission.findOne({ clientName: "Shop Alpha" }).lean();
        assert.equal(await StockReport.countDocuments({ outletId: outlet._id }), 1);
        assert.equal((await api(`/admin/submissions/${outlet._id}`, { method: "DELETE", token })).status, 200);
        assert.equal(await StockReport.countDocuments({ outletId: outlet._id }), 0);
    });

    test("admin stock endpoints require login", async () => {
        assert.equal((await api("/admin/stock/reports")).status, 401);
        assert.equal((await api("/admin/stock/reports/export")).status, 401);
        assert.equal((await api(`/admin/stock/reports/${new mongoose.Types.ObjectId()}`, { method: "DELETE" })).status, 401);
    });
});

