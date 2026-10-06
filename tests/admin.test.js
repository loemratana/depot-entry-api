import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
    FILES,
    Sale,
    Submission,
    api,
    createAdmin,
    createLocations,
    listBucketKeys,
    login,
    mongoose,
    start,
    stop,
    withGpsPhotos
} from "./helpers.js";

let fx;
let token;

// Inserted directly so dates, names and phones are fully controlled
const seedSubmissions = async () => {
    const base = (i, overrides) => ({
        submissionNo: `CL-20260101-TEST${String(i).padStart(4, "0")}`,
        clientName: `Client ${i}`,
        phone: `0120000${String(i).padStart(3, "0")}`,
        provinceId: fx.p1._id,
        provinceNameKh: fx.p1.nameKh,
        provinceNameEn: fx.p1.nameEn,
        districtId: fx.d1._id,
        districtNameKh: fx.d1.nameKh,
        districtNameEn: fx.d1.nameEn,
        communeId: fx.c1._id,
        communeNameKh: fx.c1.nameKh,
        communeNameEn: fx.c1.nameEn,
        saleGbId: fx.sale._id,
        saleGbName: fx.sale.name,
        files: [
            {
                originalName: "a.pdf",
                storedName: "x.pdf",
                bucket: "b",
                objectKey: `submissions/none/${i}.pdf`,
                mimeType: "application/pdf",
                size: 10,
                uploadedAt: new Date()
            }
        ],
        // One per day starting 2026-01-01 00:30 Cambodia time (17:30 UTC the day before)
        submittedAt: new Date(Date.UTC(2025, 11, 30 + i, 17, 30)),
        ...overrides
    });

    const docs = [];
    for (let i = 1; i <= 23; i++) docs.push(base(i));
    // Two submissions in province 2 with a distinctive Khmer name
    docs.push(
        base(24, {
            clientName: "សុខា ចាន់",
            provinceId: fx.p2._id,
            provinceNameEn: fx.p2.nameEn,
            districtId: fx.d2._id,
            communeId: fx.c2._id
        }),
        base(25, { clientName: "សុខា ពេជ្រ", provinceId: fx.p2._id, districtId: fx.d2._id, communeId: fx.c2._id })
    );
    await Submission.insertMany(docs);
};

before(async () => {
    await start();
    await createAdmin();
    fx = await createLocations();
    token = await login();
    await seedSubmissions();
});
after(stop);

const list = (query = "") => api(`/admin/submissions${query}`, { token });

describe("admin submission list", () => {
    test("defaults to page 1, limit 20, newest first", async () => {
        const res = await list();
        assert.equal(res.status, 200);
        assert.equal(res.body.data.length, 20);
        assert.deepEqual(res.body.pagination, {
            page: 1,
            limit: 20,
            total: 25,
            totalPages: 2,
            hasNextPage: true,
            hasPreviousPage: false
        });
        assert.equal(res.body.data[0].submissionNo, "CL-20260101-TEST0025");
    });

    test("list items have nested location/sale objects and a file count", async () => {
        const item = (await list("?limit=1")).body.data[0];
        assert.deepEqual(Object.keys(item).sort(), [
            "clientName", "commune", "district", "fileCount", "hasGps", "id", "phone", "province", "saleGb", "submissionNo", "submittedAt"
        ]);
        assert.equal(item.fileCount, 1);
        assert.equal(item.province.id, fx.p2._id.toString());
    });

    test("second page returns the remainder", async () => {
        const res = await list("?page=2&limit=20");
        assert.equal(res.body.data.length, 5);
        assert.equal(res.body.pagination.hasNextPage, false);
        assert.equal(res.body.pagination.hasPreviousPage, true);
    });

    test("page beyond the end is empty, not an error", async () => {
        const res = await list("?page=99");
        assert.equal(res.status, 200);
        assert.equal(res.body.data.length, 0);
    });

    test("rejects limit above 100 and invalid sort fields", async () => {
        assert.equal((await list("?limit=101")).status, 400);
        assert.equal((await list("?sortBy=phone")).status, 400);
        assert.equal((await list("?page=0")).status, 400);
    });

    test("sorts ascending by client name", async () => {
        const res = await list("?sortBy=clientName&sortOrder=asc&limit=3");
        assert.deepEqual(res.body.data.map((d) => d.clientName), ["Client 1", "Client 10", "Client 11"]);
    });

    test("search matches Khmer client names", async () => {
        const res = await list(`?search=${encodeURIComponent("សុខា")}`);
        assert.equal(res.body.pagination.total, 2);
    });

    test("search matches phone numbers ignoring spaces", async () => {
        const res = await list(`?search=${encodeURIComponent("012 0000 007")}`);
        assert.deepEqual(res.body.data.map((d) => d.clientName), ["Client 7"]);
    });

    test("search matches submission numbers case-insensitively", async () => {
        const res = await list("?search=cl-20260101-test0003");
        assert.deepEqual(res.body.data.map((d) => d.submissionNo), ["CL-20260101-TEST0003"]);
    });

    test("search treats regex characters literally", async () => {
        const res = await list(`?search=${encodeURIComponent(".*")}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.pagination.total, 0);
    });

    test("filters by province, district, commune and Sale GB", async () => {
        assert.equal((await list(`?provinceId=${fx.p2._id}`)).body.pagination.total, 2);
        assert.equal((await list(`?districtId=${fx.d1._id}`)).body.pagination.total, 23);
        assert.equal((await list(`?communeId=${fx.c2._id}`)).body.pagination.total, 2);
        assert.equal((await list(`?saleGbId=${fx.sale._id}`)).body.pagination.total, 25);
        assert.equal((await list(`?saleGbId=${fx.inactiveSale._id}`)).body.pagination.total, 0);
    });

    test("combines filters with search", async () => {
        const res = await list(`?provinceId=${fx.p2._id}&search=${encodeURIComponent("ពេជ្រ")}`);
        assert.equal(res.body.pagination.total, 1);
    });

    test("date range uses whole days in Cambodia time, inclusive", async () => {
        // Submissions i=3..5 fall on 2026-01-03 .. 2026-01-05 local time
        const res = await list("?dateFrom=2026-01-03&dateTo=2026-01-05&sortOrder=asc");
        assert.deepEqual(res.body.data.map((d) => d.submissionNo), [
            "CL-20260101-TEST0003",
            "CL-20260101-TEST0004",
            "CL-20260101-TEST0005"
        ]);
    });

    test("date and time filters use Cambodia time; the end minute is included", async () => {
        const numbers = async (query) =>
            (await list(`${query}&sortOrder=asc`)).body.data.map((d) => d.submissionNo.slice(-4));
        // Submissions are at 00:30 local time each day
        assert.deepEqual(await numbers("?dateFrom=2026-01-03T00:30&dateTo=2026-01-04T00:30"), ["0003", "0004"]);
        assert.deepEqual(await numbers("?dateFrom=2026-01-03T00:31&dateTo=2026-01-05T00:29"), ["0004"]);
        // A time on one end, a whole day on the other
        assert.deepEqual(await numbers("?dateFrom=2026-01-03T00:31&dateTo=2026-01-05"), ["0004", "0005"]);
        assert.equal((await list("?dateFrom=2026-01-03T25:00")).status, 400);
        assert.equal((await list("?dateFrom=2026-01-05T10:00&dateTo=2026-01-05T09:00")).status, 400);
    });

    test("rejects inverted and malformed date ranges", async () => {
        assert.equal((await list("?dateFrom=2026-02-01&dateTo=2026-01-01")).status, 400);
        assert.equal((await list("?dateFrom=yesterday")).status, 400);
    });

    test("rejects malformed ObjectId filters", async () => {
        const res = await list("?provinceId=nope");
        assert.equal(res.status, 400);
        assert.equal(res.body.errors[0].field, "provinceId");
    });
});

describe("admin submission details", () => {
    test("returns full details with short-lived file URLs", async () => {
        const created = await Submission.findOne({ submissionNo: "CL-20260101-TEST0001" });
        const res = await api(`/admin/submissions/${created._id}`, { token });

        assert.equal(res.status, 200);
        assert.equal(res.headers.get("cache-control"), "no-store");
        const { data } = res.body;
        assert.equal(data.submissionNo, "CL-20260101-TEST0001");
        assert.equal(data.saleGb.name, "Test Sale A");
        assert.equal(data.files.length, 1);
        assert.match(data.files[0].url, /X-Amz-Expires=\d+/);
        assert.ok(!Number.isNaN(Date.parse(data.files[0].uploadedAt)), "each file has its upload time");
        assert.ok(data.files[0].urlExpiresAt);
        assert.equal(data.files[0].objectKey, undefined);
        assert.equal(data.idempotencyKey, undefined);
    });

    test("404 for unknown id, 400 for malformed id", async () => {
        assert.equal((await api(`/admin/submissions/${new mongoose.Types.ObjectId()}`, { token })).status, 404);
        assert.equal((await api("/admin/submissions/not-an-id", { token })).status, 400);
    });
});

describe("Excel export", () => {
    const readSheet = async (buffer) => {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        return workbook.getWorksheet("Client Submissions");
    };

    test("exports all rows with a header and dated filename", async () => {
        const res = await api("/admin/submissions/export", { token });

        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /spreadsheetml/);
        assert.match(res.headers.get("content-disposition"), /client-submissions-\d{4}-\d{2}-\d{2}\.xlsx/);

        const sheet = await readSheet(res.body);
        // Seeded rows only have PDFs, so there are no photo columns; PDFs are listed by name
        assert.deepEqual(sheet.getRow(1).values.slice(1), [
            "Client Name", "Phone", "Province", "District", "Commune", "Submitted At", "Coordinates", "Other files"
        ]);
        assert.equal(sheet.rowCount, 26);
        assert.equal(sheet.getRow(2).getCell(7).value, "No GPS");
        assert.equal(sheet.getRow(2).getCell(8).value, "a.pdf");
        assert.ok(!sheet.getRow(1).values.includes("Submission No"), "Submission No is not exported");
        assert.ok(!sheet.getRow(1).values.includes("Sale GB"), "Sale GB is not exported");
    });

    test("embeds each client's photos as pictures next to the row", async () => {
        // A client with two photos and a PDF, uploaded through the admin API so the files exist in storage
        const form = new FormData();
        for (const [key, value] of Object.entries({
            clientName: "Photo Client",
            phone: "012999888",
            provinceId: fx.p1._id,
            districtId: fx.d1._id,
            communeId: fx.c1._id,
            saleGbId: fx.sale._id
        })) form.append(key, String(value));
        withGpsPhotos(form, [["front.png", FILES.png()], ["back.jpg", FILES.jpg()]]);
        form.append("files", FILES.pdf(), "contract.pdf");
        const created = await api("/admin/submissions", { method: "POST", token, form });
        assert.equal(created.status, 201);

        const res = await api(`/admin/submissions/export?search=${encodeURIComponent("Photo Client")}`, { token });
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(res.body);
        const sheet = workbook.getWorksheet("Client Submissions");

        assert.deepEqual(sheet.getRow(1).values.slice(7), ["Photo 1", "Photo 2", "Coordinates", "Other files"]);
        // The photos were sent with GPS, so the outlet has coordinates
        assert.equal(sheet.getRow(2).getCell(9).value.text, "11.556400, 104.928200");
        const images = sheet.getImages();
        assert.equal(images.length, 2);
        // Anchored in the photo columns (zero-based 6 and 7) of the client's row (zero-based 1)
        assert.deepEqual(
            images.map((image) => [Math.floor(image.range.tl.nativeCol), Math.floor(image.range.tl.nativeRow)]).sort(),
            [[6, 1], [7, 1]]
        );
        assert.equal(sheet.getRow(2).getCell(10).value, "contract.pdf");

        await api(`/admin/submissions/${created.body.data.submissionNo ? (await Submission.findOne({ clientName: "Photo Client" }))._id : ""}`, {
            method: "DELETE",
            token
        });
    });

    test("applies the same filters as the list", async () => {
        const query = `?provinceId=${fx.p2._id}&search=${encodeURIComponent("សុខា")}`;
        const listTotal = (await list(query)).body.pagination.total;

        const sheet = await readSheet((await api(`/admin/submissions/export${query}`, { token })).body);
        assert.equal(sheet.rowCount - 1, listTotal);
        assert.equal(sheet.getRow(2).getCell(1).value.startsWith("សុខា"), true);
    });

    test("respects the date range", async () => {
        const sheet = await readSheet(
            (await api("/admin/submissions/export?dateFrom=2026-01-03&dateTo=2026-01-05", { token })).body
        );
        assert.equal(sheet.rowCount - 1, 3);
    });

    test("validates filters before streaming", async () => {
        const res = await api("/admin/submissions/export?provinceId=bad", { token });
        assert.equal(res.status, 400);
    });
});

describe("admin Sale GB management", () => {
    test("creates, lists and paginates Sale GB entries", async () => {
        const created = await api("/admin/sales", { method: "POST", token, json: { name: "  New Sale  ", code: "ns1", phone: "096 111 2222" } });
        assert.equal(created.status, 201);
        assert.equal(created.body.data.name, "New Sale");
        assert.equal(created.body.data.code, "NS1");
        assert.equal(created.body.data.phone, "0961112222");

        const listed = await api("/admin/sales?search=new", { token });
        assert.equal(listed.body.pagination.total, 1);
    });

    test("only name is required", async () => {
        const res = await api("/admin/sales", { method: "POST", token, json: { name: "Name Only" } });
        assert.equal(res.status, 201);
        assert.equal(res.body.data.code, undefined);
    });

    test("duplicate code is a 409", async () => {
        const res = await api("/admin/sales", { method: "POST", token, json: { name: "Dup", code: "TSA" } });
        assert.equal(res.status, 409);
    });

    test("duplicate name (ignoring case and spaces) is a 409, on create and rename", async () => {
        const create = await api("/admin/sales", { method: "POST", token, json: { name: "test  sale A" } });
        assert.equal(create.status, 409);
        assert.equal(create.body.errors[0].field, "name");

        const other = await api("/admin/sales", { method: "POST", token, json: { name: "Rename Target" } });
        const rename = await api(`/admin/sales/${other.body.data.id}`, { method: "PATCH", token, json: { name: "TEST SALE A" } });
        assert.equal(rename.status, 409);
    });

    test("deactivating hides it from the public list; nothing is deleted", async () => {
        const sale = await Sale.findOne({ code: "NS1" });
        const res = await api(`/admin/sales/${sale._id}`, { method: "PATCH", token, json: { isActive: false } });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.isActive, false);

        const pub = await api("/public/sales");
        assert.equal(pub.body.data.some((s) => s.code === "NS1"), false);
        assert.ok(await Sale.findById(sale._id));
    });

    test("PATCH validates input and 404s on unknown id", async () => {
        const sale = await Sale.findOne({ code: "NS1" });
        assert.equal((await api(`/admin/sales/${sale._id}`, { method: "PATCH", token, json: {} })).status, 400);
        assert.equal((await api(`/admin/sales/${sale._id}`, { method: "PATCH", token, json: { unknown: 1 } })).status, 400);
        assert.equal(
            (await api(`/admin/sales/${new mongoose.Types.ObjectId()}`, { method: "PATCH", token, json: { name: "X" } })).status,
            404
        );
    });

    test("there is no DELETE endpoint", async () => {
        const sale = await Sale.findOne({ code: "NS1" });
        assert.equal((await api(`/admin/sales/${sale._id}`, { method: "DELETE", token })).status, 404);
    });
});

describe("admin client CRUD", () => {
    let id;

    const form = (fields, files) => {
        const data = new FormData();
        for (const [key, value] of Object.entries(fields)) if (value !== undefined) data.append(key, String(value));
        for (const [name, blob] of files) data.append("files", blob, name);
        return data;
    };
    const fields = (overrides = {}) => ({
        clientName: "Admin Added",
        phone: "012 111 222",
        provinceId: fx.p1._id,
        districtId: fx.d1._id,
        communeId: fx.c1._id,
        saleGbName: "Admin Typed Sale",
        ...overrides
    });
    const details = async () => (await api(`/admin/submissions/${id}`, { token })).body.data;

    test("admin creates a client with files marked as uploaded by an admin", async () => {
        const res = await api("/admin/submissions", {
            method: "POST",
            token,
            form: withGpsPhotos(form(fields(), []), [["id.png", FILES.png()]])
        });
        assert.equal(res.status, 201);
        const doc = await Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
        id = doc._id.toString();

        const data = await details();
        assert.equal(data.clientName, "Admin Added");
        assert.equal(data.phone, "012111222");
        assert.equal(data.saleGb.name, "Admin Typed Sale");
        assert.equal(data.files[0].uploadedByAdmin, true);
        assert.ok(data.files[0].uploadedAt);
    });

    test("admin create validates like the public form", async () => {
        const res = await api("/admin/submissions", { method: "POST", token, form: form(fields({ phone: "1" }), []) });
        assert.equal(res.status, 400);
        assert.deepEqual(res.body.errors.map((e) => e.field), ["phone"]);

        const noFiles = await api("/admin/submissions", { method: "POST", token, form: form(fields(), []) });
        assert.equal(noFiles.status, 400);
        assert.deepEqual(noFiles.body.errors.map((e) => e.field), ["files"]);
    });

    test("updates name/phone and refreshes location + Sale GB snapshots", async () => {
        const res = await api(`/admin/submissions/${id}`, {
            method: "PATCH",
            token,
            json: {
                clientName: "Renamed Client",
                phone: "+855 96 123 4567",
                provinceId: fx.p2._id.toString(),
                districtId: fx.d2._id.toString(),
                communeId: fx.c2._id.toString(),
                saleGbId: fx.sale._id.toString()
            }
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.clientName, "Renamed Client");
        assert.equal(res.body.data.phone, "0961234567");
        assert.equal(res.body.data.province.nameEn, "Test Province Two");
        assert.equal(res.body.data.commune.nameEn, "Test Commune Two");
        assert.equal(res.body.data.saleGb.name, "Test Sale A");
    });

    test("update rejects partial locations, bad hierarchy and unknown fields", async () => {
        const partial = await api(`/admin/submissions/${id}`, { method: "PATCH", token, json: { provinceId: fx.p1._id.toString() } });
        assert.equal(partial.status, 400);
        assert.deepEqual(partial.body.errors.map((e) => e.field).sort(), ["communeId", "districtId"]);

        const mismatch = await api(`/admin/submissions/${id}`, {
            method: "PATCH",
            token,
            json: { provinceId: fx.p1._id.toString(), districtId: fx.d2._id.toString(), communeId: fx.c2._id.toString() }
        });
        assert.equal(mismatch.status, 400);
        assert.equal(mismatch.body.errors[0].field, "districtId");

        assert.equal((await api(`/admin/submissions/${id}`, { method: "PATCH", token, json: { submissionNo: "X" } })).status, 400);
        assert.equal((await api(`/admin/submissions/${id}`, { method: "PATCH", token, json: {} })).status, 400);
        assert.equal(
            (await api(`/admin/submissions/${new mongoose.Types.ObjectId()}`, { method: "PATCH", token, json: { clientName: "Xy" } })).status,
            404
        );
    });

    test("adds files up to the limit, each with its own upload time", async () => {
        const res = await api(`/admin/submissions/${id}/files`, {
            method: "POST",
            token,
            form: form({}, [["second.pdf", FILES.pdf()], ["third.png", FILES.png()]])
        });
        assert.equal(res.status, 201);
        assert.equal(res.body.data.files.length, 3);
        assert.ok(res.body.data.files.every((f) => f.uploadedAt));

        // Test limit is 3 files per submission
        const over = await api(`/admin/submissions/${id}/files`, { method: "POST", token, form: form({}, [["x.png", FILES.png()]]) });
        assert.equal(over.status, 400);
        assert.match(over.body.errors[0].message, /at most 3 files/);

        const bad = await api(`/admin/submissions/${id}/files`, { method: "POST", token, form: form({}, [["x.txt", FILES.text()]]) });
        assert.equal(bad.status, 415);
    });

    test("removes files and deletes the stored object, but never the last file", async () => {
        const doc = await Submission.findById(id).lean();
        const [first, second, third] = doc.files;

        for (const file of [first, second]) {
            const res = await api(`/admin/submissions/${id}/files/${file._id}`, { method: "DELETE", token });
            assert.equal(res.status, 200);
        }
        assert.deepEqual(await listBucketKeys(first.objectKey), []);

        const last = await api(`/admin/submissions/${id}/files/${third._id}`, { method: "DELETE", token });
        assert.equal(last.status, 409);
        assert.match(last.body.message, /at least one file/);

        const missing = await api(`/admin/submissions/${id}/files/${first._id}`, { method: "DELETE", token });
        assert.equal(missing.status, 404);
    });

    test("deletes the client and its stored files", async () => {
        const doc = await Submission.findById(id).lean();
        const res = await api(`/admin/submissions/${id}`, { method: "DELETE", token });
        assert.equal(res.status, 200);
        assert.equal(await Submission.countDocuments({ _id: id }), 0);
        assert.deepEqual(await listBucketKeys(`submissions/${id}/`), []);
        assert.ok(doc.files.length > 0);
        assert.equal((await api(`/admin/submissions/${id}`, { method: "DELETE", token })).status, 404);
    });

    test("every client CRUD endpoint requires login", async () => {
        const some = new mongoose.Types.ObjectId();
        assert.equal((await api("/admin/submissions", { method: "POST", form: new FormData() })).status, 401);
        assert.equal((await api(`/admin/submissions/${some}`, { method: "PATCH", json: { clientName: "Xy" } })).status, 401);
        assert.equal((await api(`/admin/submissions/${some}`, { method: "DELETE" })).status, 401);
        assert.equal((await api(`/admin/submissions/${some}/files`, { method: "POST", form: new FormData() })).status, 401);
        assert.equal((await api(`/admin/submissions/${some}/files/${some}`, { method: "DELETE" })).status, 401);
    });
});
