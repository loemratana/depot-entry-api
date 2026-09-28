import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
    FILES,
    Submission,
    api,
    createLocations,
    listBucketKeys,
    start,
    stop,
    submissionForm,
    validFields
} from "./helpers.js";

let fx;

before(async () => {
    await start();
    fx = await createLocations();
});
after(stop);

const submit = (fields, files, headers) =>
    api("/public/submissions", { method: "POST", form: submissionForm(fields, files), headers });

describe("public locations", () => {
    test("provinces are active only, sorted by code, lightweight", async () => {
        const res = await api("/public/locations/provinces");
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.data.map((p) => p.code), ["01", "02"]);
        assert.deepEqual(Object.keys(res.body.data[0]).sort(), ["code", "id", "nameEn", "nameKh"]);
    });

    test("districts filter by province", async () => {
        const res = await api(`/public/locations/districts?provinceId=${fx.p1._id}`);
        assert.deepEqual(res.body.data.map((d) => d.nameEn), ["Test District One"]);
    });

    test("communes exclude inactive entries", async () => {
        const res = await api(`/public/locations/communes?districtId=${fx.d1._id}`);
        assert.deepEqual(res.body.data.map((c) => c.code), ["010101"]);
    });

    test("communes can be required to match both province and district", async () => {
        const match = await api(`/public/locations/communes?districtId=${fx.d1._id}&provinceId=${fx.p1._id}`);
        assert.deepEqual(match.body.data.map((c) => c.code), ["010101"]);

        const mismatch = await api(`/public/locations/communes?districtId=${fx.d1._id}&provinceId=${fx.p2._id}`);
        assert.deepEqual(mismatch.body.data, []);
    });

    test("parent id is required and must be a valid ObjectId", async () => {
        assert.equal((await api("/public/locations/districts")).status, 400);
        const res = await api("/public/locations/communes?districtId=123");
        assert.equal(res.status, 400);
        assert.equal(res.body.errors[0].field, "districtId");
    });
});

describe("public sales", () => {
    test("returns only active Sale GB entries", async () => {
        const res = await api("/public/sales");
        assert.deepEqual(res.body.data.map((s) => s.name), ["Test Sale A"]);
    });
});

describe("public submission", () => {
    test("creates a submission with snapshots and stores files in MinIO", async () => {
        const startedAt = Date.now();
        const res = await submit(validFields(fx), [
            ["photo.png", FILES.png()],
            ["លិខិត.pdf", FILES.pdf()]
        ]);

        assert.equal(res.status, 201);
        assert.equal(res.body.message, "Submission received successfully");
        assert.match(res.body.data.submissionNo, /^CL-\d{8}-[0-9A-Z]{8}$/);
        assert.deepEqual(Object.keys(res.body.data), ["submissionNo"]);

        const doc = await Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
        assert.equal(doc.clientName, "សុខា ចាន់");
        assert.equal(doc.phone, "012345678");
        assert.equal(doc.provinceNameEn, "Test Province One");
        assert.equal(doc.districtNameKh, "ស្រុកតេស្តមួយ");
        assert.equal(doc.communeNameEn, "Test Commune One");
        assert.equal(doc.saleGbName, "Test Sale A");
        assert.equal(doc.files.length, 2);
        assert.equal(doc.files[1].originalName, "លិខិត.pdf");
        assert.equal(doc.files[1].mimeType, "application/pdf");
        assert.match(doc.files[0].objectKey, new RegExp(`^submissions/${doc._id}/[0-9a-f-]{36}\\.png$`));
        assert.equal(doc.files[0].uploadedBy, null);

        // Every file has its own upload time, within the request and not after the submission time
        for (const file of doc.files) {
            assert.ok(file.uploadedAt instanceof Date);
            assert.ok(file.uploadedAt.getTime() >= startedAt);
            assert.ok(file.uploadedAt.getTime() <= doc.submittedAt.getTime());
        }

        const keys = await listBucketKeys(`submissions/${doc._id}/`);
        assert.equal(keys.length, 2);
    });

    test("accepts files sent as files[]", async () => {
        const form = submissionForm(validFields(fx), []);
        form.append("files[]", FILES.jpg(), "a.jpg");
        const res = await api("/public/submissions", { method: "POST", form });
        assert.equal(res.status, 201);
    });

    test("requires at least one file", async () => {
        const res = await submit(validFields(fx), []);
        assert.equal(res.status, 400);
        assert.equal(res.body.errors[0].field, "files");
    });

    test("rejects unsupported declared file types", async () => {
        const res = await submit(validFields(fx), [["notes.txt", FILES.text()]]);
        assert.equal(res.status, 415);
        assert.equal(res.body.success, false);
    });

    test("rejects files whose content does not match the declared type", async () => {
        const before = await Submission.countDocuments();
        const res = await submit(validFields(fx), [["fake.png", FILES.fakePng()]]);
        assert.equal(res.status, 415);
        assert.equal(await Submission.countDocuments(), before);
    });

    test("rejects oversized files", async () => {
        const res = await submit(validFields(fx), [["big.pdf", FILES.oversized()]]);
        assert.equal(res.status, 413);
    });

    test("rejects more files than allowed", async () => {
        const files = Array.from({ length: 4 }, (_, i) => [`f${i}.png`, FILES.png()]);
        const res = await submit(validFields(fx), files);
        assert.equal(res.status, 400);
        assert.equal(res.body.errors[0].field, "files");
    });

    test("validates required fields and phone format", async () => {
        const res = await submit({ clientName: " a ", phone: "12345" }, [["a.png", FILES.png()]]);
        assert.equal(res.status, 400);
        const fields = res.body.errors.map((e) => e.field).sort();
        assert.deepEqual(fields, ["clientName", "communeId", "districtId", "phone", "provinceId", "saleGbId"]);
    });

    test("rejects a district that does not belong to the province", async () => {
        const res = await submit(validFields(fx, { provinceId: fx.p2._id }));
        assert.equal(res.status, 400);
        assert.deepEqual(res.body.errors, [{ field: "districtId", message: "District does not belong to the selected province" }]);
    });

    test("rejects a commune that does not belong to the district", async () => {
        const res = await submit(validFields(fx, { communeId: fx.c2._id }));
        assert.equal(res.status, 400);
        assert.deepEqual(res.body.errors, [{ field: "communeId", message: "Commune does not belong to the selected district" }]);
    });

    test("rejects inactive commune and inactive Sale GB", async () => {
        const res = await submit(validFields(fx, { communeId: fx.cInactive._id, saleGbId: fx.inactiveSale._id }));
        assert.equal(res.status, 400);
        assert.deepEqual(res.body.errors.map((e) => e.field).sort(), ["communeId", "saleGbId"]);
    });

    test("rejects references that do not exist", async () => {
        const res = await submit(validFields(fx, { saleGbId: "507f1f77bcf86cd799439011" }));
        assert.equal(res.status, 400);
        assert.equal(res.body.errors[0].message, "Sale GB not found");
    });

    test("failed validation leaves no files in storage", async () => {
        const before = (await listBucketKeys()).length;
        await submit(validFields(fx, { communeId: fx.c2._id }));
        assert.equal((await listBucketKeys()).length, before);
    });
});

describe("idempotency", () => {
    test("the same Idempotency-Key returns the original submission without duplicating", async () => {
        const headers = { "Idempotency-Key": "form-test-key-0001" };

        const first = await submit(validFields(fx), undefined, headers);
        const second = await submit(validFields(fx), undefined, headers);

        assert.equal(first.status, 201);
        assert.equal(second.status, 200);
        assert.equal(second.headers.get("idempotent-replayed"), "true");
        assert.equal(second.body.data.submissionNo, first.body.data.submissionNo);
        assert.equal(await Submission.countDocuments({ submissionNo: first.body.data.submissionNo }), 1);
    });

    test("concurrent requests with the same key create exactly one submission and one set of files", async () => {
        const headers = { "Idempotency-Key": "form-test-key-race-0002" };
        const results = await Promise.all(Array.from({ length: 8 }, () => submit(validFields(fx), undefined, headers)));

        const numbers = new Set(results.map((r) => r.body.data?.submissionNo));
        assert.equal(numbers.size, 1);
        assert.ok(results.every((r) => r.status === 200 || r.status === 201));

        const docs = await Submission.find({ submissionNo: [...numbers][0] }).lean();
        assert.equal(docs.length, 1);
        const keys = await listBucketKeys(`submissions/${docs[0]._id}/`);
        assert.equal(keys.length, 1);
    });

    test("losing requests in a race leave no orphaned files", async () => {
        const allKeys = await listBucketKeys();
        const referenced = new Set(
            (await Submission.find().select("files.objectKey").lean()).flatMap((d) => d.files.map((f) => f.objectKey))
        );
        assert.deepEqual(allKeys.filter((key) => !referenced.has(key)), []);
    });

    test("rejects malformed keys", async () => {
        const res = await submit(validFields(fx), undefined, { "Idempotency-Key": "short" });
        assert.equal(res.status, 400);
    });
});

describe("concurrency", () => {
    test("many simultaneous submissions all succeed with unique numbers", async () => {
        const results = await Promise.all(
            Array.from({ length: 25 }, (_, i) => submit(validFields(fx, { clientName: `Concurrent ${i}` })))
        );
        assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join(","));
        assert.equal(new Set(results.map((r) => r.body.data.submissionNo)).size, 25);
    });
});
