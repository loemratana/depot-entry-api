/**
 * Concurrency, consistency and retry-safety tests for the performance/consistency
 * work: export limiter, outlet + stock report all-or-nothing, delete order,
 * admin races (locations, brand logo, brand/product) and admin idempotency.
 *
 * Failures that are hard to time (a crash between two writes, a delete landing
 * between two steps) are reproduced by temporarily wrapping a model method.
 */
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    FILES,
    Commune,
    District,
    Province,
    Submission,
    api,
    createAdmin,
    createLocations,
    listBucketKeys,
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
const { exportLimiter } = await import("../src/modules/export/export.controller.js");
const { createLimiter } = await import("../src/utils/limiter.js");
const { completePendingStockReports } = await import("../src/modules/submission/submission.service.js");
const locationService = await import("../src/modules/location/location.service.js");
const catalogService = await import("../src/modules/stock/catalog.service.js");
const { default: errorHandler } = await import("../src/middleware/error.middleware.js");

let fx;
let token;
let product;

before(async () => {
    await start();
    await createAdmin();
    fx = await createLocations();
    token = await login();
    const brand = await Brand.create({ name: "GANZBERG", sortOrder: 0 });
    product = await Product.create({ brandId: brand._id, name: "Ganzberg Snow" });
});
after(stop);

// ---------- helpers ----------

/** Replaces a static model method until restore(); the original is passed in */
const patches = [];
const patch = (Model, method, replacement) => {
    const original = Model[method].bind(Model);
    Model[method] = (...args) => replacement(original, ...args);
    patches.push(() => delete Model[method]);
};
afterEach(() => {
    while (patches.length) patches.pop()();
});

const items = (cases = 3) => JSON.stringify([{ productId: product._id.toString(), cases }]);

const submitOutlet = (headers, overrides = {}) =>
    api("/public/submissions", {
        method: "POST",
        form: submissionForm(validFields(fx, { saleGbId: undefined, stockItems: items(), ...overrides })),
        headers
    });

const orphanKeys = async () => {
    const referenced = new Set(
        (await Submission.find().select("files.objectKey").lean()).flatMap((d) => d.files.map((f) => f.objectKey))
    );
    return (await listBucketKeys("submissions/")).filter((key) => !referenced.has(key));
};

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
};

// ---------- export limiter ----------

describe("export limiter", () => {
    test("runs at most `concurrency` tasks at once and queues the rest in order", async () => {
        const limiter = createLimiter({ concurrency: 2, maxQueue: 10, queueTimeoutMs: 5000, busyMessage: "busy" });
        let running = 0;
        let peak = 0;
        const order = [];
        await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
                limiter.run(async () => {
                    running++;
                    peak = Math.max(peak, running);
                    await new Promise((r) => setTimeout(r, 20));
                    order.push(i);
                    running--;
                })
            )
        );
        assert.equal(peak, 2);
        assert.equal(order.length, 6);
        assert.deepEqual(limiter.stats(), { running: 0, waiting: 0 });
    });

    test("a full queue and a queue timeout both answer 503 with Retry-After; slots are released on failure", async () => {
        const limiter = createLimiter({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 50, busyMessage: "busy" });
        const gate = deferred();
        const first = limiter.run(() => gate.promise);
        const queued = limiter.run(async () => "late");

        await assert.rejects(limiter.run(async () => "x"), (e) => e.statusCode === 503 && e.retryAfterSeconds >= 1);
        await assert.rejects(queued, (e) => e.statusCode === 503); // waited longer than 50 ms

        gate.resolve();
        await first;
        await assert.rejects(limiter.run(async () => { throw new Error("boom"); }), /boom/);
        assert.deepEqual(limiter.stats(), { running: 0, waiting: 0 });
        assert.equal(await limiter.run(async () => "ok"), "ok");
    });

    test("the export endpoint returns 503 + Retry-After while exports are saturated, and works again after", async () => {
        const gate = deferred();
        const stats = exportLimiter.stats();
        assert.deepEqual(stats, { running: 0, waiting: 0 });

        // Occupy the running slot and fill the waiting queue with exports that never finish yet
        const held = [];
        held.push(exportLimiter.run(() => gate.promise));
        // Default config: 1 running, 4 waiting
        for (let i = 0; i < 4; i++) held.push(exportLimiter.run(() => gate.promise));
        assert.deepEqual(exportLimiter.stats(), { running: 1, waiting: 4 });

        const busy = await api("/admin/submissions/export", { token });
        assert.equal(busy.status, 503);
        assert.ok(Number(busy.headers.get("retry-after")) >= 1);
        assert.match(busy.body.message, /Too many exports/);

        gate.resolve();
        await Promise.all(held);
        const ok = await api("/admin/submissions/export", { token });
        assert.equal(ok.status, 200);
        assert.deepEqual(exportLimiter.stats(), { running: 0, waiting: 0 });
    });

    test("concurrent exports all succeed (queued, not rejected) within the queue size", async () => {
        const results = await Promise.all(Array.from({ length: 4 }, () => api("/admin/submissions/export", { token })));
        assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
    });
});

// ---------- outlet + stock report consistency ----------

describe("outlet and stock report are saved all or nothing", () => {
    test("a normal submission leaves one report with the outlet's id and no pending stock", async () => {
        const res = await submitOutlet({ "Idempotency-Key": "consistency-normal-0001" });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const outlet = await Submission.findOne({ submissionNo: res.body.data.submissionNo }).select("+pendingStock").lean();
        assert.equal(outlet.pendingStock, undefined);
        const reports = await StockReport.find({ outletId: outlet._id }).lean();
        assert.equal(reports.length, 1);
        assert.ok(reports[0]._id.equals(outlet._id));
        assert.equal(reports[0].items[0].cases, 3);
    });

    test("if the stock report cannot be written, the outlet and its files are removed", async () => {
        const before = await Submission.countDocuments();
        patch(StockReport, "updateOne", async () => {
            throw new Error("simulated stock write failure");
        });
        const res = await submitOutlet({}, { clientName: "Stock Failure Outlet" });
        assert.equal(res.status, 500);
        assert.equal(await Submission.countDocuments(), before);
        assert.equal(await Submission.countDocuments({ clientName: "Stock Failure Outlet" }), 0);
        assert.deepEqual(await orphanKeys(), []);
    });

    test("if the process stops mid-way, a retry with the same key finishes the report (no duplicate outlet)", async () => {
        const headers = { "Idempotency-Key": "consistency-retry-0002" };
        // Stock write fails AND the clean-up fails: the outlet stays, marked pending
        patch(StockReport, "updateOne", async () => {
            throw new Error("simulated stock write failure");
        });
        patch(Submission, "deleteOne", async () => {
            throw new Error("simulated clean-up failure");
        });
        const failed = await submitOutlet(headers, { clientName: "Pending Outlet" });
        assert.equal(failed.status, 500);
        patches.splice(0).forEach((restore) => restore());

        const pending = await Submission.findOne({ clientName: "Pending Outlet" }).select("+pendingStock").lean();
        assert.ok(pending.pendingStock, "outlet keeps its stock as pending");
        assert.equal(await StockReport.countDocuments({ outletId: pending._id }), 0);

        // The client retries with the same key
        const retry = await submitOutlet(headers, { clientName: "Pending Outlet" });
        assert.equal(retry.status, 200);
        assert.equal(retry.headers.get("idempotent-replayed"), "true");
        assert.equal(retry.body.data.submissionNo, pending.submissionNo);

        assert.equal(await Submission.countDocuments({ clientName: "Pending Outlet" }), 1);
        assert.equal(await StockReport.countDocuments({ outletId: pending._id }), 1);
        const done = await Submission.findById(pending._id).select("+pendingStock").lean();
        assert.equal(done.pendingStock, undefined);
    });

    test("startup repair finishes pending reports; running it concurrently still gives one report each", async () => {
        const [a, b] = await Submission.find({ pendingStock: { $exists: false } }).limit(2).lean();
        // Simulate outlets whose process stopped right after the outlet write
        for (const outlet of [a, b]) {
            await StockReport.deleteMany({ outletId: outlet._id });
            await Submission.collection.updateOne(
                { _id: outlet._id },
                {
                    $set: {
                        pendingStock: {
                            outletName: outlet.clientName,
                            provinceId: outlet.provinceId,
                            provinceNameKh: outlet.provinceNameKh,
                            districtId: outlet.districtId,
                            districtNameKh: outlet.districtNameKh,
                            communeId: outlet.communeId,
                            communeNameKh: outlet.communeNameKh,
                            items: [
                                { productId: product._id, brandId: product.brandId, brandName: "GANZBERG", productName: "Ganzberg Snow", cases: 9 }
                            ],
                            reportedAt: new Date(),
                            submittedBy: null
                        }
                    }
                }
            );
        }

        const counts = await Promise.all([completePendingStockReports(), completePendingStockReports(), completePendingStockReports()]);
        assert.ok(counts.some((n) => n >= 2));
        for (const outlet of [a, b]) {
            const reports = await StockReport.find({ outletId: outlet._id }).lean();
            assert.equal(reports.length, 1);
            assert.equal(reports[0].items[0].cases, 9);
        }
        assert.equal(await Submission.countDocuments({ pendingStock: { $exists: true } }), 0);
        assert.equal(await completePendingStockReports(), 0);
    });

    test("concurrent submissions with the same key give one outlet and one stock report", async () => {
        const headers = { "Idempotency-Key": "consistency-race-0003" };
        const results = await Promise.all(Array.from({ length: 6 }, () => submitOutlet(headers, { clientName: "Race Outlet" })));
        assert.ok(results.every((r) => r.status === 200 || r.status === 201));
        assert.equal(new Set(results.map((r) => r.body.data.submissionNo)).size, 1);
        const outlets = await Submission.find({ clientName: "Race Outlet" }).lean();
        assert.equal(outlets.length, 1);
        assert.equal(await StockReport.countDocuments({ outletId: outlets[0]._id }), 1);
        assert.deepEqual(await orphanKeys(), []);
    });
});

// ---------- delete order ----------

describe("deleting an outlet", () => {
    test("removes stock reports before the outlet; a failure part-way leaves no report without its outlet", async () => {
        const res = await submitOutlet({}, { clientName: "Delete Order Outlet" });
        const outlet = await Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
        assert.equal(await StockReport.countDocuments({ outletId: outlet._id }), 1);

        // The outlet delete fails after the reports were removed
        patch(Submission, "findOneAndDelete", () => {
            throw new Error("simulated failure");
        });
        const failed = await api(`/admin/submissions/${outlet._id}`, { method: "DELETE", token });
        assert.equal(failed.status, 500);
        patches.splice(0).forEach((restore) => restore());
        assert.equal(await StockReport.countDocuments({ outletId: outlet._id }), 0);
        assert.equal(await Submission.countDocuments({ _id: outlet._id }), 1);

        // Deleting again finishes the job: outlet and files gone
        const ok = await api(`/admin/submissions/${outlet._id}`, { method: "DELETE", token });
        assert.equal(ok.status, 200);
        assert.equal(await Submission.countDocuments({ _id: outlet._id }), 0);
        assert.deepEqual(await listBucketKeys(`submissions/${outlet._id}/`), []);
    });

    test("two concurrent deletes: one succeeds, the other gets 404", async () => {
        const res = await submitOutlet({}, { clientName: "Double Delete Outlet" });
        const outlet = await Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
        const results = await Promise.all([
            api(`/admin/submissions/${outlet._id}`, { method: "DELETE", token }),
            api(`/admin/submissions/${outlet._id}`, { method: "DELETE", token })
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
        assert.equal(await StockReport.countDocuments({ outletId: outlet._id }), 0);
    });
});

// ---------- admin: create outlet idempotency ----------

describe("admin create outlet with Idempotency-Key", () => {
    const adminForm = (clientName) =>
        withGpsPhotos(submissionForm(validFields(fx, { clientName }), []), [["front.png", FILES.png()]]);

    test("concurrent requests with the same key add exactly one outlet", async () => {
        const headers = { "Idempotency-Key": "admin-create-race-0001" };
        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                api("/admin/submissions", { method: "POST", token, form: adminForm("Admin Race Outlet"), headers })
            )
        );
        const statuses = results.map((r) => r.status).sort();
        assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(statuses));
        assert.ok(statuses.every((s) => s === 200 || s === 201));
        assert.ok(results.filter((r) => r.status === 200).every((r) => r.headers.get("idempotent-replayed") === "true"));
        assert.equal(await Submission.countDocuments({ clientName: "Admin Race Outlet" }), 1);
        assert.deepEqual(await orphanKeys(), []);
    });

    test("without a key each request adds an outlet (unchanged); a malformed key is rejected", async () => {
        const a = await api("/admin/submissions", { method: "POST", token, form: adminForm("No Key Outlet") });
        const b = await api("/admin/submissions", { method: "POST", token, form: adminForm("No Key Outlet") });
        assert.deepEqual([a.status, b.status], [201, 201]);
        const bad = await api("/admin/submissions", {
            method: "POST",
            token,
            form: adminForm("Bad Key Outlet"),
            headers: { "Idempotency-Key": "short" }
        });
        assert.equal(bad.status, 400);
    });
});

// ---------- admin: location races ----------

describe("location delete / create races", () => {
    test("a failed delete puts the location's active state back", async () => {
        // p1 has districts and submissions
        await assert.rejects(locationService.deleteLocation("provinces", fx.p1._id.toString()), (e) => e.statusCode === 409);
        assert.equal((await Province.findById(fx.p1._id).lean()).isActive, true);
    });

    test("an unused location can still be deleted", async () => {
        const created = await locationService.createLocation("provinces", { nameKh: "ខេត្តលុប", nameEn: "To Delete" });
        await locationService.deleteLocation("provinces", created.id);
        assert.equal(await Province.countDocuments({ _id: created.id }), 0);
    });

    test("a child added after the delete's check puts the parent back (409), no orphan", async () => {
        const parent = await locationService.createLocation("provinces", { nameKh: "ខេត្តប្រណាំង", nameEn: "Race Province" });
        // A district lands between the check and the delete
        patch(Province, "deleteOne", async (original, ...args) => {
            await District.create({ provinceId: parent.id, code: "RACE", nameKh: "ស្រុកប្រណាំង" });
            return original(...args);
        });
        await assert.rejects(locationService.deleteLocation("provinces", parent.id), (e) => e.statusCode === 409);
        const restored = await Province.findById(parent.id).lean();
        assert.ok(restored, "parent restored");
        assert.equal(restored.isActive, true);
        assert.equal(await District.countDocuments({ provinceId: parent.id }), 1);
    });

    test("a child created while its parent is deleted removes itself (422), no orphan", async () => {
        const parent = await locationService.createLocation("provinces", { nameKh: "ខេត្តបាត់", nameEn: "Vanishing Province" });
        patch(District, "create", async (original, ...args) => {
            const doc = await original(...args);
            await Province.deleteOne({ _id: parent.id });
            return doc;
        });
        await assert.rejects(
            locationService.createLocation("districts", { parentId: parent.id, nameKh: "ស្រុកកំព្រា" }),
            (e) => e.statusCode === 400 || e.statusCode === 422
        );
        assert.equal(await District.countDocuments({ provinceId: parent.id }), 0);
    });

    test("parallel create-child and delete-parent never leave an orphan", async () => {
        for (let i = 0; i < 10; i++) {
            const parent = await locationService.createLocation("districts", {
                parentId: fx.d1.provinceId.toString(),
                nameKh: `ស្រុកស្រប ${i}`
            });
            await Promise.allSettled([
                locationService.createLocation("communes", { parentId: parent.id, nameKh: `ឃុំស្រប ${i}` }),
                locationService.deleteLocation("districts", parent.id)
            ]);
            const parentExists = await District.exists({ _id: parent.id });
            const children = await Commune.countDocuments({ districtId: parent.id });
            assert.ok(parentExists || children === 0, `iteration ${i}: orphan commune`);
        }
    });
});

// ---------- admin: brand logo and products ----------

describe("brand logo and product races", () => {
    const logoForm = () => {
        const form = new FormData();
        form.append("logo", FILES.png(), "logo.png");
        return form;
    };

    test("concurrent logo uploads leave exactly one stored logo, the one the brand points to", async () => {
        const brand = await Brand.create({ name: "LOGO RACE" });
        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                api(`/admin/stock/brands/${brand._id}/logo`, { method: "PUT", token, form: logoForm() })
            )
        );
        assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
        const keys = await listBucketKeys(`brands/${brand._id}/`);
        const current = (await Brand.findById(brand._id).lean()).logo.objectKey;
        assert.deepEqual(keys, [current]);

        const removed = await api(`/admin/stock/brands/${brand._id}/logo`, { method: "DELETE", token });
        assert.equal(removed.status, 200);
        assert.deepEqual(await listBucketKeys(`brands/${brand._id}/`), []);
    });

    test("deleting a brand removes its products and logo", async () => {
        const brand = await Brand.create({ name: "DELETE ME" });
        await api(`/admin/stock/brands/${brand._id}/logo`, { method: "PUT", token, form: logoForm() });
        await Product.create({ brandId: brand._id, name: "Doomed" });
        const res = await api(`/admin/stock/brands/${brand._id}`, { method: "DELETE", token });
        assert.equal(res.status, 200);
        assert.equal(await Product.countDocuments({ brandId: brand._id }), 0);
        assert.deepEqual(await listBucketKeys(`brands/${brand._id}/`), []);
        assert.equal((await api(`/admin/stock/brands/${brand._id}`, { method: "DELETE", token })).status, 404);
    });

    test("a product added while its brand is deleted is removed (404), no orphan", async () => {
        const brand = await Brand.create({ name: "VANISHING BRAND" });
        patch(Product, "create", async (original, ...args) => {
            const doc = await original(...args);
            await Brand.deleteOne({ _id: brand._id });
            return doc;
        });
        await assert.rejects(catalogService.createProduct(brand._id.toString(), { name: "Orphan" }), (e) => e.statusCode === 404);
        assert.equal(await Product.countDocuments({ brandId: brand._id }), 0);
    });

    test("a logo uploaded while its brand is deleted is removed from storage (404)", async () => {
        const brand = await Brand.create({ name: "LOGO VANISH" });
        // The service chains .lean(), so keep returning the query and delete just before it runs
        patch(Brand, "findOneAndUpdate", (original, ...args) => {
            const query = original(...args);
            const exec = query.exec.bind(query);
            query.exec = async (...execArgs) => {
                await Brand.deleteOne({ _id: brand._id });
                return exec(...execArgs);
            };
            return query;
        });
        const res = await api(`/admin/stock/brands/${brand._id}/logo`, { method: "PUT", token, form: logoForm() });
        assert.equal(res.status, 404);
        assert.deepEqual(await listBucketKeys(`brands/${brand._id}/`), []);
    });
});

// ---------- error mapping ----------

describe("timeouts map to 503 with Retry-After", () => {
    const run = (err) => {
        const res = {
            headersSent: false,
            headers: {},
            set(name, value) {
                this.headers[name] = value;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                this.body = body;
                return this;
            }
        };
        const originalError = console.error;
        console.error = () => {};
        try {
            errorHandler(err, { method: "GET", originalUrl: "/test" }, res, () => {});
        } finally {
            console.error = originalError;
        }
        return res;
    };

    test("a query over its time limit (maxTimeMS)", () => {
        const err = Object.assign(new Error("operation exceeded time limit"), { code: 50, codeName: "MaxTimeMSExpired" });
        const res = run(err);
        assert.equal(res.statusCode, 503);
        assert.equal(res.headers["Retry-After"], "10");
        assert.match(res.body.message, /took too long/);
    });

    test("no database connection free in time (waitQueueTimeoutMS)", () => {
        const err = new Error("Timed out while checking out a connection from connection pool");
        err.name = "WaitQueueTimeoutError";
        const res = run(err);
        assert.equal(res.statusCode, 503);
        assert.equal(res.headers["Retry-After"], "5");
    });

    test("other errors are unchanged (no Retry-After)", () => {
        const res = run(new Error("unexpected"));
        assert.equal(res.statusCode, 500);
        assert.equal(res.headers["Retry-After"], undefined);
    });
});
