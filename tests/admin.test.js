import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { Sale, Submission, api, createAdmin, createLocations, login, start, stop, mongoose } from "./helpers.js";

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
            "clientName", "commune", "district", "fileCount", "id", "phone", "province", "saleGb", "submissionNo", "submittedAt"
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
        assert.deepEqual(sheet.getRow(1).values.slice(1), [
            "Submission No", "Client Name", "Phone", "Province", "District", "Commune", "Sale GB", "Submitted At"
        ]);
        assert.equal(sheet.rowCount, 26);
    });

    test("applies the same filters as the list", async () => {
        const query = `?provinceId=${fx.p2._id}&search=${encodeURIComponent("សុខា")}`;
        const listTotal = (await list(query)).body.pagination.total;

        const sheet = await readSheet((await api(`/admin/submissions/export${query}`, { token })).body);
        assert.equal(sheet.rowCount - 1, listTotal);
        assert.equal(sheet.getRow(2).getCell(2).value.startsWith("សុខា"), true);
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
