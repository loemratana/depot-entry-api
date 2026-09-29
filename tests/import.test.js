import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { Commune, District, Province, Submission, api, createAdmin, login, start, stop } from "./helpers.js";

const { parseWorkbook, syncLocations, nameKey } = await import("../src/modules/location/location.import.js");

let token;

before(async () => {
    await start();
    await createAdmin();
    token = await login();
});
after(stop);

const workbookBuffer = async (headers, rows) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(headers);
    rows.forEach((row) => sheet.addRow(row));
    return Buffer.from(await workbook.xlsx.writeBuffer());
};

const writeFixture = async (headers, rows) => {
    const file = path.join(os.tmpdir(), `import-${process.pid}-${Date.now()}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer(headers, rows));
    await workbook.xlsx.writeFile(file);
    return file;
};

// The admin's own template: Khmer names only, no codes
const TEMPLATE = ["ខេត្ត/ក្រុង", "ខណ្ឌ/ស្រុក", "ឃុំ/ភូមិ"];

const CODED_HEADERS = ["Province Code", "ខេត្ត", "Province", "District Code", "ស្រុក", "District", "Commune Code", "ឃុំ", "Commune"];
const CODED_ROWS = [
    [1, "ខេត្តក", "Province A", 101, "ស្រុកក", "District A", 10101, "ឃុំក", "Commune A"],
    [null, null, null, null, null, null, 10102, "ឃុំខ", "Commune B"],
    [2, "ខេត្តខ", "Province B", 201, "ស្រុកខ", "District B", 20101, "ឃុំគ", "Commune C"]
];

const upload = (buffer, { dryRun, name = "locations.xlsx", type } = {}) => {
    const form = new FormData();
    form.append(
        "file",
        new Blob([buffer], { type: type ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        name
    );
    return api(`/admin/locations/import${dryRun === undefined ? "" : `?dryRun=${dryRun}`}`, {
        method: "POST",
        token,
        form
    });
};

describe("name key", () => {
    test("ignores spaces, zero-width characters and ្ដ/្ត", () => {
        assert.equal(nameKey("ភ្នំ ពេញ"), nameKey("ភ្នំពេញ"));
        assert.equal(nameKey("កណ្ដាល"), nameKey("កណ្តាល"));
        assert.equal(nameKey("ឃុំ\u200Bក"), nameKey("ឃុំក"));
        assert.notEqual(nameKey("ឃុំក"), nameKey("ឃុំខ"));
    });
});

describe("location import with codes (database)", () => {
    test("first import creates everything with ObjectId relationships", async () => {
        const result = await syncLocations(await parseWorkbook(await writeFixture(CODED_HEADERS, CODED_ROWS)));

        assert.deepEqual(result.provinces, { created: 2, updated: 0, unchanged: 0, matchedByName: 0 });
        assert.deepEqual(result.districts, { created: 2, updated: 0, unchanged: 0, matchedByName: 0 });
        assert.deepEqual(result.communes, { created: 3, updated: 0, unchanged: 0, matchedByName: 0 });

        const province = await Province.findOne({ code: "01" });
        const district = await District.findOne({ code: "0101" });
        const commune = await Commune.findOne({ code: "010102" });
        assert.ok(district.provinceId.equals(province._id));
        assert.ok(commune.districtId.equals(district._id));
        assert.ok(commune.provinceId.equals(province._id));
        assert.equal(commune.isActive, true);
    });

    test("re-import is a no-op", async () => {
        const result = await syncLocations(await parseWorkbook(await writeFixture(CODED_HEADERS, CODED_ROWS)));
        assert.equal(result.communes.created, 0);
        assert.equal(result.communes.unchanged, 3);
        assert.equal(await Commune.countDocuments(), 3);
    });

    test("renames are applied and deactivated locations stay deactivated", async () => {
        await Commune.updateOne({ code: "010101" }, { isActive: false });

        const renamed = CODED_ROWS.map((row) => [...row]);
        renamed[0][8] = "Commune A (renamed)";
        const result = await syncLocations(await parseWorkbook(await writeFixture(CODED_HEADERS, renamed)));

        assert.deepEqual(result.communes, { created: 0, updated: 1, unchanged: 2, matchedByName: 0 });
        const commune = await Commune.findOne({ code: "010101" });
        assert.equal(commune.nameEn, "Commune A (renamed)");
        assert.equal(commune.isActive, false);
    });
});

describe("admin template (Khmer names, no codes)", () => {
    const ROWS = [
        ["ភ្នំពេញ", "ចំការមន", "ទន្លេបាសាក់"],
        ["ភ្នំពេញ", "ចំការមន", "បឹងកេងកង"],
        ["ភ្នំ ពេញ", "ចំការមន", "ទន្លេ បាសាក់"], // same names with stray spaces
        ["កណ្ដាល", "តាខ្មៅ", "តាខ្មៅ"],
        ["កណ្តាល", "តាខ្មៅ", "ព្រែកឫស្សី"], // ្ត instead of ្ដ
        [null, null, "ដើមមៀន"], // grouped rows
        ["កណ្ដាល", null, null] // province-only row
    ];

    test("ឃុំ/ភូមិ is read as the commune column and duplicate names are merged", async () => {
        const parsed = await parseWorkbook(await workbookBuffer(TEMPLATE, ROWS));

        assert.equal(parsed.sheetsUsed[0].childLevel, "commune");
        assert.equal(parsed.provinces.size, 2);
        assert.equal(parsed.districts.size, 2);
        assert.equal(parsed.communes.size, 5);
        assert.deepEqual(
            parsed.duplicates.map((d) => [d.row, d.level, d.name, d.duplicateOf]),
            [
                [4, "province", "ភ្នំ ពេញ", "ភ្នំពេញ"],
                [4, "commune", "ទន្លេ បាសាក់", "ទន្លេបាសាក់"],
                [6, "province", "កណ្តាល", "កណ្ដាល"]
            ]
        );
        assert.deepEqual(parsed.invalid, []);
    });

    test("check (dry run) reports without saving anything", async () => {
        const before = await Province.countDocuments();
        const res = await upload(await workbookBuffer(TEMPLATE, ROWS));

        assert.equal(res.status, 200);
        const { data } = res.body;
        assert.equal(data.dryRun, true);
        assert.deepEqual(data.inFile, { provinces: 2, districts: 2, communes: 5 });
        assert.equal(data.result.provinces.created, 2);
        assert.equal(data.result.communes.created, 5);
        assert.equal(data.duplicates.total, 3);
        assert.equal(await Province.countDocuments(), before);
    });

    test("import saves, and uploading again creates nothing", async () => {
        const first = await upload(await workbookBuffer(TEMPLATE, ROWS), { dryRun: false });
        assert.equal(first.status, 200);
        assert.equal(first.body.data.result.communes.created, 5);

        const again = await upload(await workbookBuffer(TEMPLATE, ROWS), { dryRun: false });
        assert.deepEqual(again.body.data.result.communes, { created: 0, updated: 0, unchanged: 5, matchedByName: 0 });

        const phnomPenh = await Province.find({ nameKh: /ភ្នំ/ });
        assert.equal(phnomPenh.length, 1);
        assert.equal(phnomPenh[0].nameKh, "ភ្នំពេញ");
    });

    test("names already in the database are matched even with a different spelling or code", async () => {
        // Existing province with a real code; the upload uses the name only, spelled with a space
        await Province.create({ code: "99", nameKh: "ខេត្តតេស្ត", nameEn: "Test" });

        const res = await upload(await workbookBuffer(TEMPLATE, [["ខេត្ត តេស្ត", "ស្រុកថ្មី", "ឃុំថ្មី"]]), { dryRun: false });

        assert.deepEqual(res.body.data.result.provinces, { created: 0, updated: 0, unchanged: 1, matchedByName: 1 });
        assert.equal(await Province.countDocuments({ nameKh: /តេស្ត/ }), 1);
        const district = await District.findOne({ nameKh: "ស្រុកថ្មី" });
        assert.equal((await Province.findById(district.provinceId)).code, "99");
    });

    test("the same commune name may exist under different districts", async () => {
        const res = await upload(
            await workbookBuffer(TEMPLATE, [
                ["ខេត្តក", "ស្រុកមួយ", "ឃុំដូចគ្នា"],
                ["ខេត្តក", "ស្រុកពីរ", "ឃុំដូចគ្នា"]
            ]),
            { dryRun: false }
        );
        assert.equal(res.body.data.result.communes.created, 2);
        assert.equal(res.body.data.duplicates.total, 0);
    });
});

describe("admin location CRUD", () => {
    let provinceId;
    let districtId;
    let communeId;

    const post = (level, json) => api(`/admin/locations/${level}`, { method: "POST", token, json });
    const patch = (level, id, json) => api(`/admin/locations/${level}/${id}`, { method: "PATCH", token, json });
    const del = (level, id) => api(`/admin/locations/${level}/${id}`, { method: "DELETE", token });

    test("creates a province, a district in it and a commune in that district", async () => {
        const province = await post("provinces", { nameKh: "  ខេត្ត  ថ្មី ", nameEn: "New Province" });
        assert.equal(province.status, 201);
        assert.equal(province.body.data.nameKh, "ខេត្ត ថ្មី");
        provinceId = province.body.data.id;

        const district = await post("districts", { parentId: provinceId, nameKh: "ស្រុកថ្មី" });
        assert.equal(district.status, 201);
        assert.equal(district.body.data.provinceId, provinceId);
        districtId = district.body.data.id;

        const commune = await post("communes", { parentId: districtId, nameKh: "ឃុំថ្មី" });
        assert.equal(commune.status, 201);
        assert.equal(commune.body.data.districtId, districtId);
        assert.equal(commune.body.data.provinceId, provinceId);
        communeId = commune.body.data.id;

        // Visible in the public cascade straight away
        const pub = await api(`/public/locations/communes?districtId=${districtId}&provinceId=${provinceId}`);
        assert.deepEqual(
            pub.body.data.map((c) => c.nameKh),
            ["ឃុំថ្មី"]
        );
    });

    test("rejects duplicate names under the same parent (ignoring spaces and ្ដ/្ត)", async () => {
        const dupProvince = await post("provinces", { nameKh: "ខេត្តថ្មី" });
        assert.equal(dupProvince.status, 409);
        assert.equal(dupProvince.body.errors[0].field, "nameKh");

        assert.equal((await post("communes", { parentId: districtId, nameKh: "ឃុំ ថ្មី" })).status, 409);

        // The same commune name in another district is fine
        const other = await post("districts", { parentId: provinceId, nameKh: "ស្រុកផ្សេង" });
        const sameName = await post("communes", { parentId: other.body.data.id, nameKh: "ឃុំថ្មី" });
        assert.equal(sameName.status, 201);
        assert.equal((await del("communes", sameName.body.data.id)).status, 200);
        assert.equal((await del("districts", other.body.data.id)).status, 200);

        // Renaming into an existing sibling name is also rejected
        const sibling = await post("communes", { parentId: districtId, nameKh: "ឃុំទីពីរ" });
        assert.equal((await patch("communes", sibling.body.data.id, { nameKh: "ឃុំថ្មី" })).status, 409);
        assert.equal((await del("communes", sibling.body.data.id)).status, 200);
    });

    test("validates input", async () => {
        assert.equal((await post("districts", { nameKh: "x" })).status, 400);
        assert.equal((await post("communes", { parentId: "507f1f77bcf86cd799439011", nameKh: "x" })).status, 400);
        assert.equal((await post("provinces", { nameKh: "  " })).status, 400);
        assert.equal((await patch("provinces", provinceId, {})).status, 400);
        assert.equal((await patch("provinces", provinceId, { code: "X" })).status, 400);
        assert.equal((await patch("provinces", "507f1f77bcf86cd799439011", { nameEn: "x" })).status, 404);
    });

    test("renames and deactivates; deactivated locations leave the public lists", async () => {
        const renamed = await patch("communes", communeId, { nameKh: "ឃុំកែប្រែ", nameEn: "Renamed" });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.body.data.nameEn, "Renamed");

        const off = await patch("communes", communeId, { isActive: false });
        assert.equal(off.body.data.isActive, false);
        const pub = await api(`/public/locations/communes?districtId=${districtId}`);
        assert.deepEqual(pub.body.data, []);

        // Still listed for admins, marked inactive
        const table = await api(`/admin/locations?provinceId=${provinceId}`, { token });
        assert.equal(table.body.data[0].commune.isActive, false);
    });

    test("delete is blocked while children exist, then works bottom-up", async () => {
        const blocked = await del("provinces", provinceId);
        assert.equal(blocked.status, 409);
        assert.match(blocked.body.message, /still has 1 districts/);

        assert.equal((await del("communes", communeId)).status, 200);
        assert.equal((await del("districts", districtId)).status, 200);
        assert.equal((await del("provinces", provinceId)).status, 200);
        assert.equal((await del("provinces", provinceId)).status, 404);
    });

    test("a location used by a submission cannot be deleted", async () => {
        const commune = await Commune.findOne();
        await Submission.create({
            submissionNo: "CL-20260101-USEDLOC1",
            clientName: "Test",
            phone: "012345678",
            provinceId: commune.provinceId,
            provinceNameKh: "x",
            districtId: commune.districtId,
            districtNameKh: "x",
            communeId: commune._id,
            communeNameKh: "x",
            saleGbId: commune._id,
            saleGbName: "x",
            files: [{ originalName: "a.pdf", storedName: "a.pdf", bucket: "b", objectKey: "k", mimeType: "application/pdf", size: 1, uploadedAt: new Date() }]
        });
        const res = await del("communes", commune._id);
        assert.equal(res.status, 409);
        assert.match(res.body.message, /used by 1 submission/);
    });

    test("CRUD requires login", async () => {
        assert.equal((await api("/admin/locations/provinces", { method: "POST", json: { nameKh: "x" } })).status, 401);
        assert.equal((await api(`/admin/locations/provinces/${provinceId}`, { method: "PATCH", json: { nameKh: "x" } })).status, 401);
        assert.equal((await api(`/admin/locations/provinces/${provinceId}`, { method: "DELETE" })).status, 401);
    });
});

describe("admin location endpoints", () => {
    test("summary returns totals", async () => {
        const res = await api("/admin/locations/summary", { token });
        assert.equal(res.status, 200);
        assert.ok(res.body.data.provinces.total > 0);
        assert.deepEqual(Object.keys(res.body.data.communes).sort(), ["active", "total"]);
    });

    test("template downloads with the three Khmer headers", async () => {
        const res = await api("/admin/locations/template", { token });
        assert.equal(res.status, 200);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(res.body);
        assert.deepEqual(workbook.worksheets[0].getRow(1).values.slice(1), TEMPLATE);
    });

    test("rejects non-Excel files, fake .xlsx, missing file and unknown layouts", async () => {
        assert.equal((await upload(Buffer.from("a,b,c"), { name: "data.csv", type: "text/csv" })).status, 415);
        assert.equal((await upload(Buffer.from("not a zip"))).status, 415);

        const missing = await api("/admin/locations/import", { method: "POST", token, form: new FormData() });
        assert.equal(missing.status, 400);

        const unknown = await upload(await workbookBuffer(["Name", "Phone"], [["a", "b"]]));
        assert.equal(unknown.status, 400);
        assert.match(unknown.body.errors[0].message, /ខេត្ត\/ក្រុង/);
    });

    test("list returns rows grouped by province, including provinces without districts", async () => {
        await Province.create({ code: "empty-test", nameKh: "ខេត្តទទេ", nameEn: "Empty" });

        const all = await api("/admin/locations?limit=100", { token });
        assert.equal(all.status, 200);
        const rows = all.body.data;
        assert.deepEqual(Object.keys(rows[0]).sort(), ["commune", "district", "id", "province"]);
        assert.deepEqual(Object.keys(rows[0].province).sort(), ["id", "isActive", "nameEn", "nameKh"]);

        // Rows of one province are adjacent
        const order = rows.map((r) => r.province.id).filter((id, i, list) => id !== list[i - 1]);
        assert.equal(new Set(order).size, order.length);

        const empty = rows.find((r) => r.province.nameKh === "ខេត្តទទេ");
        assert.equal(empty.district, null);
        assert.equal(empty.commune, null);

        const search = await api(`/admin/locations?search=${encodeURIComponent("ទន្លេ")}`, { token });
        assert.ok(search.body.data.length > 0);
        assert.ok(
            search.body.data.every((r) => /ទន្លេ/.test([r.province.nameKh, r.district?.nameKh, r.commune?.nameKh].join(" ")))
        );

        const provinceId = rows[0].province.id;
        const byProvince = await api(`/admin/locations?provinceId=${provinceId}`, { token });
        assert.ok(byProvince.body.data.every((r) => r.province.id === provinceId));

        const page = await api("/admin/locations?limit=2&page=1", { token });
        assert.equal(page.body.data.length, 2);
        assert.equal(page.body.pagination.total, all.body.pagination.total);
        assert.equal((await api("/admin/locations?limit=500", { token })).status, 400);
    });

    test("all location admin endpoints require login", async () => {
        assert.equal((await api("/admin/locations")).status, 401);
        assert.equal((await api("/admin/locations/summary")).status, 401);
        assert.equal((await api("/admin/locations/template")).status, 401);
        assert.equal((await api("/admin/locations/import", { method: "POST" })).status, 401);
    });
});
