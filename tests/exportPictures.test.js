/**
 * Pictures in the Excel exports: every photo of an outlet (stock export too,
 * like the outlet export), embedded as small previews that a background job
 * makes once; until then the original photo is used.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import sharp from "sharp";
import {
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
const { backfillPhotoDerivatives } = await import("../src/modules/submission/photoDerivatives.service.js");

let fx;
let token;
let product;

before(async () => {
    await start();
    await createAdmin();
    fx = await createLocations();
    token = await login();
    const brand = await Brand.create({ name: "GANZBERG", sortOrder: 0, measures: ["cases"] });
    product = await Product.create({ brandId: brand._id, name: "Ganzberg Snow" });
});
after(stop);

/** A real, decodable photo (under the 1 MB test upload limit) */
const photo = async (type = "jpeg", { width = 1000, height = 750 } = {}) => {
    const noise = Buffer.alloc(width * height * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const image = sharp(noise, { raw: { width, height, channels: 3 } });
    const buffer = await (type === "webp" ? image.webp({ quality: 75 }) : image.jpeg({ quality: 75 })).toBuffer();
    return new Blob([buffer], { type: `image/${type}` });
};

const createOutlet = async (clientName, photos) => {
    const form = withGpsPhotos(
        submissionForm(
            validFields(fx, { clientName, stockItems: JSON.stringify([{ productId: product._id.toString(), cases: 2 }]) }),
            []
        ),
        photos
    );
    const res = await api("/public/submissions", { method: "POST", form });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
};

const loadSheet = async (path, name) => {
    const res = await api(path, { token });
    assert.equal(res.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    return { workbook, sheet: workbook.getWorksheet(name), bytes: res.body.length };
};

const rowOf = (sheet, column, value) => {
    const col = sheet.getRow(1).values.indexOf(column);
    for (let r = 2; r <= sheet.rowCount; r++) if (sheet.getRow(r).getCell(col).value === value) return r;
    return -1;
};

describe("export pictures", () => {
    let three;
    let one;

    before(async () => {
        three = await createOutlet("Three Photo Shop", [
            ["front.jpg", await photo()],
            ["side.webp", await photo("webp")],
            ["back.jpg", await photo()]
        ]);
        one = await createOutlet("One Photo Shop", [["front.jpg", await photo()]]);
    });

    test("stock export shows every photo of the outlet, one column each, like the outlet export", async () => {
        const { sheet } = await loadSheet("/admin/stock/reports/export", "Stock Reports");
        const headers = sheet.getRow(1).values.slice(1);
        assert.deepEqual(headers.slice(-4), ["Photo 1", "Photo 2", "Photo 3", "Coordinates"]);

        const firstPhotoCol = headers.indexOf("Photo 1"); // zero-based, as image anchors use
        const threeRow = rowOf(sheet, "Outlet", "Three Photo Shop") - 1;
        const oneRow = rowOf(sheet, "Outlet", "One Photo Shop") - 1;
        const placed = sheet.getImages().map((image) => [Math.floor(image.range.tl.nativeRow), Math.floor(image.range.tl.nativeCol)]);
        // All three photos (the WebP one too) on its row; the other outlet has one
        assert.deepEqual(
            placed.filter(([row]) => row === threeRow).map(([, col]) => col).sort(),
            [firstPhotoCol, firstPhotoCol + 1, firstPhotoCol + 2]
        );
        assert.deepEqual(placed.filter(([row]) => row === oneRow).map(([, col]) => col), [firstPhotoCol]);
    });

    test("before previews exist, exports use the originals and never make previews while you wait", async () => {
        const { workbook } = await loadSheet("/admin/stock/reports/export", "Stock Reports");
        // JPEGs as uploaded; the WebP photo converted so Excel can show it
        assert.equal(workbook.model.media.filter((m) => m.type === "image").length, 4);
        assert.deepEqual(await listBucketKeys("previews/"), []);
    });

    test("the background job makes each photo's export preview and map thumbnail once", async () => {
        assert.equal(await backfillPhotoDerivatives(), 4);
        const saved = await Submission.findById(three._id).lean();
        assert.ok(saved.files.every((file) => /^previews\/submissions\/.+\.jpg$/.test(file.previewKey)));
        assert.ok(saved.files.every((file) => /^thumbnails\/submissions\/.+\.jpg$/.test(file.thumbnailKey)));
        assert.equal((await listBucketKeys("previews/")).length, 4);
        assert.equal((await listBucketKeys("thumbnails/")).length, 4);
        // Nothing left to do
        assert.equal(await backfillPhotoDerivatives(), 0);
    });

    test("pictures are small previews, not the original photos", async () => {
        const { workbook, bytes } = await loadSheet("/admin/stock/reports/export", "Stock Reports");
        const media = workbook.model.media.filter((m) => m.type === "image");
        assert.equal(media.length, 4);
        for (const image of media) {
            const meta = await sharp(image.buffer).metadata();
            assert.equal(meta.format, "jpeg");
            assert.ok(meta.width <= 220 && meta.height <= 160, `${meta.width}x${meta.height}`);
        }
        const originals = (await Submission.find({}, { "files.size": 1 }).lean()).flatMap((d) => d.files).reduce((s, f) => s + f.size, 0);
        assert.ok(bytes < originals / 10, `export ${bytes} bytes vs originals ${originals}`);
    });

    test("later exports reuse the stored previews", async () => {
        const before = await listBucketKeys("previews/");
        await loadSheet("/admin/submissions/export", "Client Submissions");
        assert.deepEqual((await listBucketKeys("previews/")).sort(), before.sort());
    });

    test("the outlet export uses the same previews", async () => {
        const { workbook, sheet } = await loadSheet(
            `/admin/submissions/export?search=${encodeURIComponent("Three Photo Shop")}`,
            "Client Submissions"
        );
        assert.deepEqual(sheet.getRow(1).values.slice(7, 10), ["Photo 1", "Photo 2", "Photo 3"]);
        assert.equal(sheet.getImages().length, 3);
        for (const image of workbook.model.media) {
            assert.ok((await sharp(image.buffer).metadata()).width <= 220);
        }
        // The WebP photo is shown, not listed by name
        assert.equal(sheet.getRow(2).getCell(sheet.getRow(1).values.indexOf("Other files")).value, null);
    });

    test("deleting the outlet deletes its previews", async () => {
        const keys = (await Submission.findById(one._id).lean()).files.map((f) => f.previewKey);
        assert.equal((await api(`/admin/submissions/${one._id}`, { method: "DELETE", token })).status, 200);
        const left = await listBucketKeys("previews/");
        assert.ok(keys.every((key) => !left.includes(key)));
    });
});
