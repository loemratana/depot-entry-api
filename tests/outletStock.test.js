/**
 * Admin: editing an outlet's stock, or adding it again after it was deleted
 * (PUT /admin/submissions/:id/stock), and the stock.update permission.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
    FILES,
    Role,
    Submission,
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
const { StockReport } = await import("../src/modules/stock/stockReport.model.js");
const { ensureRbac } = await import("../src/modules/rbac/rbac.service.js");

let fx;
let token;
let snow;
let wedding;
let outlet;

before(async () => {
    await start();
    await createAdmin();
    fx = await createLocations();
    token = await login();
    const [ganzberg, weddingBrand] = await Brand.create([
        { name: "GANZBERG", sortOrder: 0 },
        { name: "WEDDING", sortOrder: 1, measures: ["cases"] }
    ]);
    snow = await Product.create({ brandId: ganzberg._id, name: "Ganzberg Snow" });
    wedding = await Product.create({ brandId: weddingBrand._id, name: "Wedding Gold" });

    const form = withGpsPhotos(
        submissionForm(
            validFields(fx, {
                clientName: "Stock Edit Shop",
                stockItems: JSON.stringify([
                    { productId: snow._id.toString(), cases: 3, canRings: 2 },
                    { productId: wedding._id.toString(), cases: 1 }
                ])
            }),
            []
        ),
        [["shop.png", FILES.png()]]
    );
    const res = await api("/public/submissions", { method: "POST", form });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    outlet = await Submission.findOne({ clientName: "Stock Edit Shop" }).lean();
});
after(stop);

const putStock = (stockItems, auth = token, id = outlet._id) =>
    api(`/admin/submissions/${id}/stock`, { method: "PUT", token: auth, json: { stockItems } });

const quantities = (report) =>
    Object.fromEntries(report.items.map((item) => [item.productName, { cases: item.cases, canRings: item.canRings }]));

describe("admin edits an outlet's stock", () => {
    test("changes the quantities of its report; date and report stay the same", async () => {
        const before = await StockReport.findOne({ outletId: outlet._id }).lean();
        const res = await putStock([
            { productId: snow._id.toString(), cases: 10, canRings: 4 },
            { productId: wedding._id.toString(), cases: 0 }
        ]);
        assert.equal(res.status, 200, JSON.stringify(res.body));

        const reports = await StockReport.find({ outletId: outlet._id }).lean();
        assert.equal(reports.length, 1);
        assert.equal(String(reports[0]._id), String(before._id));
        assert.equal(reports[0].reportedAt.getTime(), before.reportedAt.getTime());
        assert.deepEqual(quantities(reports[0]), {
            "Ganzberg Snow": { cases: 10, canRings: 4 },
            "Wedding Gold": { cases: 0, canRings: 0 }
        });
        assert.ok(reports[0].updatedBy);
        // The response is the saved report, as the Stock page shows it
        assert.equal(res.body.data.id, String(before._id));
    });

    test("adds the stock again after its report was deleted, dated like the outlet", async () => {
        const report = await StockReport.findOne({ outletId: outlet._id }).lean();
        assert.equal((await api(`/admin/stock/reports/${report._id}`, { method: "DELETE", token })).status, 200);
        assert.equal(await StockReport.countDocuments({ outletId: outlet._id }), 0);

        const res = await putStock([{ productId: snow._id.toString(), cases: 7 }]);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const added = await StockReport.findOne({ outletId: outlet._id }).lean();
        assert.equal(added.outletName, "Stock Edit Shop");
        assert.equal(String(added.provinceId), String(outlet.provinceId));
        assert.equal(added.communeNameKh, outlet.communeNameKh);
        assert.equal(added.reportedAt.getTime(), outlet.submittedAt.getTime());
        assert.deepEqual(quantities(added), { "Ganzberg Snow": { cases: 7, canRings: 0 } });
        // It shows up on the Stock page again
        const listed = await api(`/admin/stock/reports?outletId=${outlet._id}`, { token });
        assert.equal(listed.body.pagination.total, 1);
    });

    test("two saves at the same moment still leave one report", async () => {
        await StockReport.deleteMany({ outletId: outlet._id });
        const results = await Promise.all([1, 2, 3, 4].map((n) => putStock([{ productId: snow._id.toString(), cases: n }])));
        assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
        assert.equal(await StockReport.countDocuments({ outletId: outlet._id }), 1);
    });

    test("quantities are checked like on the outlet form", async () => {
        const unknown = await putStock([{ productId: fx.p1._id.toString(), cases: 1 }]);
        assert.equal(unknown.status, 400);
        assert.equal(unknown.body.errors[0].field, "stockItems.0.productId");

        // Wedding counts cases only
        const notCounted = await putStock([{ productId: wedding._id.toString(), canRings: 3 }]);
        assert.equal(notCounted.status, 400);

        assert.equal((await putStock([])).status, 400);
        assert.equal((await putStock([{ productId: snow._id.toString(), cases: -1 }])).status, 400);
        // Nothing was changed by the refused saves
        const report = await StockReport.findOne({ outletId: outlet._id }).lean();
        assert.equal(report.items.length, 1);
    });

    test("an unknown outlet is 404; it needs stock.update", async () => {
        assert.equal((await putStock([{ productId: snow._id.toString(), cases: 1 }], token, fx.p1._id)).status, 404);

        const viewer = await createUserWithPermissions(["outlets.view", "stock.view"]);
        assert.equal((await putStock([{ productId: snow._id.toString(), cases: 1 }], viewer.token)).status, 403);
        const editor = await createUserWithPermissions(["outlets.view", "stock.view", "stock.update"]);
        assert.equal((await putStock([{ productId: snow._id.toString(), cases: 2 }], editor.token)).status, 200);
        assert.equal((await putStock([{ productId: snow._id.toString(), cases: 2 }])).status, 200);
    });
});

describe("stock.update for the built-in roles", () => {
    test("Manager and Staff get it once; removing it on the Roles page is kept", async () => {
        const staff = await Role.findOne({ key: "staff" }).lean();
        const manager = await Role.findOne({ key: "manager" }).lean();
        assert.ok(staff.permissions.includes("stock.update"));
        assert.ok(manager.permissions.includes("stock.update"));
        assert.ok(!(await Role.findOne({ key: "viewer" }).lean()).permissions.includes("stock.update"));

        // An older Staff role (created before stock.update existed) gets it at the next start
        await Role.updateOne({ key: "staff" }, { $pull: { permissions: "stock.update" }, $set: { addedPermissions: [] } });
        await ensureRbac();
        assert.ok((await Role.findOne({ key: "staff" }).lean()).permissions.includes("stock.update"));

        // Removed by an admin afterwards: not given back
        await Role.updateOne({ key: "staff" }, { $pull: { permissions: "stock.update" } });
        await ensureRbac();
        assert.ok(!(await Role.findOne({ key: "staff" }).lean()).permissions.includes("stock.update"));
    });
});
