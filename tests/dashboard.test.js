import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
    Submission,
    api,
    createAdmin,
    createLocations,
    createUserWithPermissions,
    login,
    start,
    stop,
    submissionForm,
    validFields
} from "./helpers.js";

const { Brand } = await import("../src/modules/stock/brand.model.js");
const { Product, backfillProductShortNames } = await import("../src/modules/stock/product.model.js");
const { StockReport } = await import("../src/modules/stock/stockReport.model.js");

let fx;
let token;
let gold;
let snow;
let weddingGold;

before(async () => {
    await start();
    await createAdmin();
    fx = await createLocations();
    token = await login();

    const [ganzberg, wedding] = await Brand.create([
        { name: "GANZBERG", sortOrder: 0 },
        { name: "GANZBERG BEER WEDDING", sortOrder: 1, measures: ["cases"] }
    ]);
    [snow, gold] = await Product.create([
        { brandId: ganzberg._id, name: "Ganzberg Snow", sortOrder: 0 },
        { brandId: ganzberg._id, name: "Ganzberg Gold", sortOrder: 1 }
    ]);
    weddingGold = await Product.create({ brandId: wedding._id, name: "ស្រាបៀរហ្គេនបឺគ Gold រោងការ" });
    await backfillProductShortNames();

    // Outlet A in province 1 (today): Gold 5 cases + 2 can rings, Wedding Gold 3
    // Outlet B in province 2 (today): Gold 10 cases
    // Outlet C in province 1, moved to an old date: Gold 100 cases
    const outlet = (clientName, location, items) =>
        api("/public/submissions", {
            method: "POST",
            form: submissionForm(validFields(fx, { saleGbId: undefined, clientName, ...location, stockItems: JSON.stringify(items) }))
        });
    const p1 = { provinceId: fx.p1._id, districtId: fx.d1._id, communeId: fx.c1._id };
    const p2 = { provinceId: fx.p2._id, districtId: fx.d2._id, communeId: fx.c2._id };
    for (const res of [
        await outlet("Outlet A", p1, [
            { productId: gold._id.toString(), cases: 5, canRings: 2 },
            { productId: weddingGold._id.toString(), cases: 3 }
        ]),
        await outlet("Outlet B", p2, [{ productId: gold._id.toString(), cases: 10 }]),
        await outlet("Outlet C", p1, [{ productId: gold._id.toString(), cases: 100 }])
    ]) {
        assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    const old = new Date("2025-01-15T10:00:00+07:00");
    const c = await Submission.findOneAndUpdate({ clientName: "Outlet C" }, { $set: { submittedAt: old } }, { returnDocument: "after" });
    await StockReport.updateOne({ outletId: c._id }, { $set: { reportedAt: old } });
});
after(stop);

const dashboard = (query = "", auth = token) => api(`/admin/dashboard${query}`, { token: auth });
const card = (body, product) => body.data.products.find((p) => p.productId === product._id.toString());

describe("dashboard", () => {
    test("all time: outlet counts and per-product totals, in stock-form order with short names", async () => {
        const res = await dashboard();
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.todayOutlets, 2);
        assert.equal(res.body.data.totalOutlets, 3);

        const names = res.body.data.products.map((p) => p.shortName);
        assert.deepEqual(names, ["GB Snow", "GB Gold", "GB Gold Wedding"]);

        assert.deepEqual(card(res.body, gold).totals, { cases: 115, canRings: 2, cashRingsUsd: 0, cashRingsKhr: 0 });
        assert.equal(card(res.body, gold).outlets, 3);
        // Wedding beer only counts cases
        assert.deepEqual(card(res.body, weddingGold).totals, { cases: 3 });
        // Products nobody reported still get a card, at 0
        assert.deepEqual(card(res.body, snow).totals.cases, 0);
        assert.equal(card(res.body, snow).outlets, 0);
    });

    test("province / district / commune filters apply to every card", async () => {
        const p1 = (await dashboard(`?provinceId=${fx.p1._id}`)).body.data;
        assert.equal(p1.totalOutlets, 2);
        assert.equal(p1.todayOutlets, 1);
        assert.equal(p1.products.find((p) => p.shortName === "GB Gold").totals.cases, 105);

        const commune2 = (await dashboard(`?provinceId=${fx.p2._id}&districtId=${fx.d2._id}&communeId=${fx.c2._id}`)).body.data;
        assert.equal(commune2.totalOutlets, 1);
        assert.equal(commune2.products.find((p) => p.shortName === "GB Gold").totals.cases, 10);
        assert.equal(commune2.products.find((p) => p.shortName === "GB Gold Wedding").totals.cases, 0);
    });

    test("date range limits totals; Today stays today", async () => {
        const recent = (await dashboard("?dateFrom=2026-01-01")).body.data;
        assert.equal(recent.totalOutlets, 2);
        assert.equal(recent.products.find((p) => p.shortName === "GB Gold").totals.cases, 15);

        const old = (await dashboard("?dateFrom=2025-01-15&dateTo=2025-01-15")).body.data;
        assert.equal(old.totalOutlets, 1);
        assert.equal(old.todayOutlets, 2, "Today is not limited by the period");
        assert.equal(old.products.find((p) => p.shortName === "GB Gold").totals.cases, 100);

        assert.equal((await dashboard("?dateFrom=2026-02-01&dateTo=2026-01-01")).status, 400);
        assert.equal((await dashboard("?dateFrom=nope")).status, 400);
        assert.equal((await dashboard("?provinceId=123")).status, 400);
    });

    test("permissions: outlets.view to open it; stock cards only with stock.view", async () => {
        const outletsOnly = await createUserWithPermissions(["outlets.view"]);
        const res = await dashboard("", outletsOnly.token);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.totalOutlets, 3);
        assert.equal(res.body.data.products, null);

        const stockOnly = await createUserWithPermissions(["stock.view"]);
        assert.equal((await dashboard("", stockOnly.token)).status, 403);
        assert.equal((await api("/admin/dashboard")).status, 401);
    });

    test("short names: set from the admin page, kept by the startup backfill", async () => {
        const res = await api(`/admin/stock/products/${snow._id}`, { method: "PATCH", token, json: { shortName: "Snow!" } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        await backfillProductShortNames();
        assert.equal((await Product.findById(snow._id).lean()).shortName, "Snow!");
        assert.equal((await dashboard()).body.data.products[0].shortName, "Snow!");

        // Cleared: the card falls back to the product name
        await api(`/admin/stock/products/${snow._id}`, { method: "PATCH", token, json: { shortName: "" } });
        const named = (await dashboard()).body.data.products.find((p) => p.productId === snow._id.toString());
        assert.equal(named.shortName, "Ganzberg Snow");
    });
});
