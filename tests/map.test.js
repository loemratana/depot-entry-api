import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
    FILES,
    Submission,
    api,
    createAdmin,
    createLocations,
    listBucketKeys,
    login,
    start,
    stop,
    submissionForm,
    validFields
} from "./helpers.js";

let fx;
let token;

before(async () => {
    await start();
    await createAdmin();
    fx = await createLocations();
    token = await login();
});
after(stop);

let photoCounter = 0;
const newPhotoId = () => `photo-${Date.now().toString(36)}-${(photoCounter++).toString().padStart(4, "0")}`;

const gps = (photoId, overrides = {}) => ({
    photoId,
    latitude: 11.5564,
    longitude: 104.9282,
    accuracy: 12.5,
    capturedAt: new Date().toISOString(),
    ...overrides
});

/**
 * Public form submission with site photos. `photos` are [{ photoId, name, blob }]
 * sent as sitePhotos[<photoId>] parts; `meta` is sent as the sitePhotoMeta JSON string.
 */
const submitWithPhotos = ({ fields = {}, documents = [], photos = [], meta } = {}) => {
    const form = submissionForm(
        validFields(fx, {
            saleGbId: undefined,
            ...fields,
            sitePhotoMeta: meta === undefined ? undefined : typeof meta === "string" ? meta : JSON.stringify(meta)
        }),
        documents
    );
    for (const photo of photos) form.append(`sitePhotos[${photo.photoId}]`, photo.blob ?? FILES.jpg(), photo.name);
    return api("/public/submissions", { method: "POST", form });
};

const findBySubmissionNo = (submissionNo) => Submission.findOne({ submissionNo }).lean();

const details = async (id) => (await api(`/admin/submissions/${id}`, { token })).body.data;

describe("public submission with geotagged site photos", () => {
    test("one photo with GPS is stored as GeoJSON [longitude, latitude]", async () => {
        const photoId = newPhotoId();
        const res = await submitWithPhotos({
            photos: [{ photoId, name: "site.jpg" }],
            meta: [gps(photoId)]
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const doc = await findBySubmissionNo(res.body.data.submissionNo);
        assert.equal(doc.files.length, 1);
        const file = doc.files[0];
        assert.equal(file.photoId, photoId);
        assert.deepEqual(file.location, { type: "Point", coordinates: [104.9282, 11.5564] });
        assert.equal(file.accuracy, 12.5);
        assert.ok(file.capturedAt instanceof Date);

        const detail = await details(doc._id.toString());
        assert.deepEqual(
            { ...detail.files[0].gps, capturedAt: undefined },
            { photoId, latitude: 11.5564, longitude: 104.9282, accuracy: 12.5, capturedAt: undefined }
        );
    });

    test("several photos keep their own GPS, matched by photoId rather than order", async () => {
        const ids = [newPhotoId(), newPhotoId(), newPhotoId()];
        const res = await submitWithPhotos({
            photos: ids.map((photoId, i) => ({ photoId, name: `p${i}.jpg`, blob: i === 1 ? FILES.png() : FILES.jpg() })),
            // GPS listed in the opposite order to the files
            meta: [...ids].reverse().map((photoId, i) => gps(photoId, { latitude: 10 + i, longitude: 103 + i, accuracy: i }))
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const doc = await findBySubmissionNo(res.body.data.submissionNo);
        const byName = Object.fromEntries(doc.files.map((f) => [f.originalName, f]));
        // ids[2] was first in the GPS list (i = 0), ids[0] last (i = 2)
        assert.deepEqual(byName["p2.jpg"].location.coordinates, [103, 10]);
        assert.deepEqual(byName["p1.jpg"].location.coordinates, [104, 11]);
        assert.deepEqual(byName["p0.jpg"].location.coordinates, [105, 12]);
        assert.equal(byName["p0.jpg"].photoId, ids[0]);
        assert.equal(byName["p0.jpg"].accuracy, 2);
    });

    test("documents without GPS still work next to site photos, and on their own", async () => {
        const photoId = newPhotoId();
        const mixed = await submitWithPhotos({
            documents: [["contract.pdf", FILES.pdf()]],
            photos: [{ photoId, name: "site.jpg" }],
            meta: [gps(photoId)]
        });
        assert.equal(mixed.status, 201, JSON.stringify(mixed.body));
        const doc = await findBySubmissionNo(mixed.body.data.submissionNo);
        const pdf = doc.files.find((f) => f.originalName === "contract.pdf");
        assert.equal(pdf.location, undefined);
        assert.equal(pdf.photoId, undefined);

        const pdfOnly = await submitWithPhotos({ documents: [["only.pdf", FILES.pdf()]] });
        assert.equal(pdfOnly.status, 201, JSON.stringify(pdfOnly.body));
        const pdfDoc = await findBySubmissionNo(pdfOnly.body.data.submissionNo);
        assert.equal((await details(pdfDoc._id.toString())).files[0].gps, null);
    });

    test("a photo without GPS, or GPS without a photo, is rejected before anything is stored", async () => {
        const before = (await listBucketKeys()).length;
        const [a, b] = [newPhotoId(), newPhotoId()];

        const noGps = await submitWithPhotos({ photos: [{ photoId: a, name: "a.jpg" }], meta: [] });
        assert.equal(noGps.status, 400);
        assert.equal(noGps.body.errors[0].field, `sitePhotos.${a}`);

        const noPhoto = await submitWithPhotos({
            documents: [["doc.png", FILES.png()]],
            meta: [gps(b)]
        });
        assert.equal(noPhoto.status, 400);
        assert.equal(noPhoto.body.errors[0].field, `sitePhotoMeta.${b}`);

        assert.equal((await listBucketKeys()).length, before);
    });

    test("malformed GPS is rejected", async () => {
        const cases = [
            { latitude: 91 },
            { latitude: -90.5 },
            { longitude: 180.1 },
            { longitude: -181 },
            { accuracy: -1 },
            { latitude: "11.5" },
            { capturedAt: "yesterday" },
            { capturedAt: "2999-01-01T00:00:00Z" },
            { photoId: "bad id!" }
        ];
        for (const overrides of cases) {
            const photoId = newPhotoId();
            const res = await submitWithPhotos({
                photos: [{ photoId, name: "a.jpg" }],
                meta: [gps(photoId, overrides)]
            });
            assert.equal(res.status, 400, JSON.stringify(overrides));
            assert.ok(res.body.errors.some((e) => e.field?.startsWith("sitePhotoMeta")), JSON.stringify(res.body));
        }

        const notJson = await submitWithPhotos({ photos: [{ photoId: newPhotoId(), name: "a.jpg" }], meta: "{oops" });
        assert.equal(notJson.status, 400);
    });

    test("a site photo must really be an image", async () => {
        const photoId = newPhotoId();
        const pdfAsPhoto = await submitWithPhotos({
            photos: [{ photoId, name: "a.pdf", blob: FILES.pdf() }],
            meta: [gps(photoId)]
        });
        assert.equal(pdfAsPhoto.status, 415);

        const fake = await submitWithPhotos({
            photos: [{ photoId, name: "fake.png", blob: FILES.fakePng() }],
            meta: [gps(photoId)]
        });
        assert.equal(fake.status, 415);
        assert.equal(fake.body.errors[0].field, `sitePhotos.${photoId}`);
    });

    test("site photos count toward the file limit", async () => {
        // MAX_FILES_PER_SUBMISSION is 3 in tests
        const ids = [newPhotoId(), newPhotoId()];
        const res = await submitWithPhotos({
            documents: [["a.pdf", FILES.pdf()], ["b.pdf", FILES.pdf()]],
            photos: ids.map((photoId) => ({ photoId, name: `${photoId}.jpg` })),
            meta: ids.map((photoId) => gps(photoId))
        });
        assert.equal(res.status, 400);
    });
});

describe("GET /api/admin/map/submissions", () => {
    let insideP1;
    let insideP2;
    let oldStyle;

    before(async () => {
        await Submission.deleteMany({});

        const first = newPhotoId();
        const second = newPhotoId();
        const third = newPhotoId();
        const r1 = await submitWithPhotos({
            fields: { clientName: "Outlet One" },
            photos: [
                { photoId: second, name: "second.jpg" },
                { photoId: first, name: "first.jpg" }
            ],
            meta: [
                gps(first, { latitude: 11.1, longitude: 104.1, capturedAt: "2026-09-29T01:00:00Z" }),
                gps(second, { latitude: 11.2, longitude: 104.2, capturedAt: "2026-09-29T03:00:00Z" })
            ]
        });
        const r2 = await submitWithPhotos({
            fields: { clientName: "Outlet Two", provinceId: fx.p2._id, districtId: fx.d2._id, communeId: fx.c2._id },
            photos: [{ photoId: third, name: "third.jpg" }],
            meta: [gps(third, { latitude: 13.3, longitude: 103.3, capturedAt: "2026-09-29T02:00:00Z" })],
            documents: [["doc.pdf", FILES.pdf()]]
        });
        assert.equal(r1.status, 201);
        assert.equal(r2.status, 201);
        insideP1 = await findBySubmissionNo(r1.body.data.submissionNo);
        insideP2 = await findBySubmissionNo(r2.body.data.submissionNo);
        // Outlet Two was submitted in January
        await Submission.updateOne({ _id: insideP2._id }, { $set: { submittedAt: new Date("2026-01-15T05:00:00Z") } });

        // A submission from before GPS existed: a photo with no location fields.
        // Photos now need GPS, so it is stored as a document and then turned into an old-style photo
        const plain = await api("/public/submissions", {
            method: "POST",
            form: submissionForm(validFields(fx, { saleGbId: undefined, clientName: "Old Outlet" }))
        });
        assert.equal(plain.status, 201);
        await Submission.updateOne(
            { submissionNo: plain.body.data.submissionNo },
            { $set: { "files.0.mimeType": "image/jpeg", "files.0.originalName": "old.jpg" } }
        );
        oldStyle = await findBySubmissionNo(plain.body.data.submissionNo);
    });

    const getMap = (query = "", auth = token) => api(`/admin/map/submissions${query}`, { token: auth });

    test("requires an admin token; there is no public map endpoint", async () => {
        assert.equal((await getMap("", null)).status, 401);
        assert.equal((await getMap("", "not-a-token")).status, 401);
        assert.equal((await api("/public/map/submissions")).status, 404);
    });

    test("returns one point per geotagged photo, oldest capture first", async () => {
        const res = await getMap();
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.deepEqual(
            res.body.data.map((p) => [p.clientName, p.latitude, p.longitude]),
            [
                ["Outlet One", 11.1, 104.1],
                ["Outlet Two", 13.3, 103.3],
                ["Outlet One", 11.2, 104.2]
            ]
        );
        const point = res.body.data[0];
        assert.equal(point.submissionId, insideP1._id.toString());
        assert.equal(point.id, insideP1.files.find((f) => f.originalName === "first.jpg")._id.toString());
        assert.equal(point.provinceNameEn, "Test Province One");
        assert.equal(point.communeNameKh, "ឃុំតេស្តមួយ");
        assert.equal(point.accuracy, 12.5);
        assert.equal(point.capturedAt, "2026-09-29T01:00:00.000Z");
        assert.match(point.photoUrl, /X-Amz-Signature=/);
        // Storage details stay on the server
        assert.equal(point.objectKey, undefined);
    });

    test("old submissions without GPS are left off the map but still open normally", async () => {
        const res = await getMap();
        assert.ok(!res.body.data.some((p) => p.submissionId === oldStyle._id.toString()));
        const detail = await details(oldStyle._id.toString());
        assert.equal(detail.clientName, "Old Outlet");
        assert.equal(detail.files[0].gps, null);

        const list = await api("/admin/submissions", { token });
        assert.equal(list.status, 200);
        assert.equal(list.body.pagination.total, 3);
        // The outlet list says which outlets can be shown on the map
        const hasGps = Object.fromEntries(list.body.data.map((row) => [row.clientName, row.hasGps]));
        assert.deepEqual(hasGps, { "Outlet One": true, "Outlet Two": true, "Old Outlet": false });
        assert.equal(detail.hasGps, false);
    });

    test("filters by province, district, commune, date and outlet", async () => {
        const names = async (query) => (await getMap(query)).body.data.map((p) => p.clientName);

        assert.deepEqual(await names(`?provinceId=${fx.p2._id}`), ["Outlet Two"]);
        assert.deepEqual(await names(`?districtId=${fx.d1._id}`), ["Outlet One", "Outlet One"]);
        assert.deepEqual(await names(`?communeId=${fx.c2._id}`), ["Outlet Two"]);
        assert.deepEqual(await names("?dateFrom=2026-01-15&dateTo=2026-01-15"), ["Outlet Two"]);
        assert.deepEqual(await names("?dateTo=2026-01-14"), []);
        assert.deepEqual(await names(`?submissionId=${insideP1._id}`), ["Outlet One", "Outlet One"]);
    });

    test("empty results are a normal response; bad filters are rejected", async () => {
        const empty = await getMap(`?communeId=${fx.cInactive._id}`);
        assert.equal(empty.status, 200);
        assert.deepEqual(empty.body.data, []);

        assert.equal((await getMap("?provinceId=nope")).status, 400);
        assert.equal((await getMap("?dateFrom=2026-02-01&dateTo=2026-01-01")).status, 400);
    });
});

describe("admin Add outlet uses the same form as the public one", () => {
    test("an admin can add an outlet with a GPS site photo; it is recorded as added by the admin", async () => {
        const photoId = newPhotoId();
        const form = submissionForm(
            validFields(fx, { saleGbId: undefined, clientName: "Admin Photo Outlet", sitePhotoMeta: JSON.stringify([gps(photoId)]) }),
            []
        );
        form.append(`sitePhotos[${photoId}]`, FILES.jpg(), "shop.jpg");
        const res = await api("/admin/submissions", { method: "POST", token, form });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const doc = await findBySubmissionNo(res.body.data.submissionNo);
        assert.equal(doc.files.length, 1);
        assert.equal(doc.files[0].photoId, photoId);
        assert.deepEqual(doc.files[0].location.coordinates, [104.9282, 11.5564]);
        assert.ok(doc.files[0].uploadedBy, "file records the admin who added it");
    });
});

describe("exports show the site photo coordinates", () => {
    test("Outlet export: Coordinates column right after the photos, with a Google Maps link", async () => {
        const photoId = newPhotoId();
        const res = await submitWithPhotos({
            fields: { clientName: "Coords Outlet", stockItems: undefined },
            photos: [{ photoId, name: "shop.jpg" }],
            meta: [gps(photoId, { latitude: 11.5564, longitude: 104.9282 })]
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const ExcelJS = (await import("exceljs")).default;
        const load = async (url, sheetName) => {
            const file = await api(url, { token });
            assert.equal(file.status, 200);
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(file.body);
            return workbook.getWorksheet(sheetName);
        };
        const sheet = await load(`/admin/submissions/export?search=${encodeURIComponent("Coords Outlet")}`, "Client Submissions");
        const col = sheet.getRow(1).values.indexOf("Coordinates");
        assert.ok(col > 0, "Coordinates column present");
        assert.equal(sheet.getRow(1).values[col - 1], "Photo 1", "right after the photos");
        const cell = sheet.getRow(2).getCell(col).value;
        assert.equal(cell.text, "11.556400, 104.928200");
        assert.equal(cell.hyperlink, "https://www.google.com/maps?q=11.5564,104.9282");
    });
});
