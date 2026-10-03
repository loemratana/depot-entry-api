/**
 * Where does an image-heavy export spend its time?
 * Uses the TEST database and bucket (see tests/helpers.js), never real data.
 *
 *   BENCH_PHOTOS=/path/a.jpg,/path/b.jpg node tests/bench/export-timing.bench.js
 *
 * Seeds BENCH_OUTLETS outlets with BENCH_PHOTOS_PER_OUTLET photos each (real JPEGs
 * from BENCH_PHOTOS) plus a stock report each, then times:
 *   - each stage of the outlet export (query, downloads, workbook, write)
 *   - the full HTTP exports (outlet and stock), as an admin would see them
 */
import fs from "node:fs";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { BUCKET, Submission, api, createAdmin, createLocations, login, minioClient, start, stop } from "../helpers.js";

const { buildSubmissionsExport } = await import("../../src/modules/export/export.service.js");
const { downloadObject, mapWithLimit, DOWNLOAD_CONCURRENCY } = await import("../../src/utils/excel-images.js");
const { buildSubmissionFilter } = await import("../../src/modules/submission/submission.service.js");
const { StockReport } = await import("../../src/modules/stock/stockReport.model.js");
const { Brand } = await import("../../src/modules/stock/brand.model.js");
const { Product } = await import("../../src/modules/stock/product.model.js");

const OUTLETS = Number(process.env.BENCH_OUTLETS || 200);
const PER_OUTLET = Number(process.env.BENCH_PHOTOS_PER_OUTLET || 3);
const photos = (process.env.BENCH_PHOTOS || "").split(",").filter(Boolean).map((p) => fs.readFileSync(p));
if (!photos.length) throw new Error("Set BENCH_PHOTOS to one or more JPEG paths");

const ms = (start) => Math.round(performance.now() - start);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";

await start();
try {
    await createAdmin();
    const fx = await createLocations();
    const token = await login();
    const brand = await Brand.create({ name: "GANZBERG" });
    const product = await Product.create({ brandId: brand._id, name: "Ganzberg Gold" });

    // ---------- seed ----------
    let t = performance.now();
    const docs = [];
    const uploads = [];
    for (let i = 0; i < OUTLETS; i++) {
        const _id = new mongoose.Types.ObjectId();
        const files = Array.from({ length: PER_OUTLET }, (_, p) => {
            const buffer = photos[(i + p) % photos.length];
            const objectKey = `submissions/${_id}/photo-${p}.jpg`;
            uploads.push({ objectKey, buffer });
            return {
                originalName: `photo-${p}.jpg`,
                storedName: `photo-${p}.jpg`,
                bucket: BUCKET,
                objectKey,
                mimeType: "image/jpeg",
                size: buffer.length,
                uploadedAt: new Date(),
                photoId: `bench-${i}-${p}`,
                location: { type: "Point", coordinates: [104.9 + i / 1e4, 11.55] }
            };
        });
        docs.push({
            _id,
            submissionNo: `CL-BENCH-${String(i).padStart(5, "0")}`,
            clientName: `Bench Outlet ${i}`,
            phone: "012345678",
            provinceId: fx.p1._id,
            provinceNameKh: fx.p1.nameKh,
            districtId: fx.d1._id,
            districtNameKh: fx.d1.nameKh,
            communeId: fx.c1._id,
            communeNameKh: fx.c1.nameKh,
            files,
            submittedAt: new Date(Date.now() - i * 60000)
        });
    }
    await mapWithLimit(uploads, 16, ({ objectKey, buffer }) => minioClient.putObject(BUCKET, objectKey, buffer, buffer.length, { "Content-Type": "image/jpeg" }));
    await Submission.insertMany(docs);
    await StockReport.insertMany(
        docs.map((d) => ({
            outletId: d._id,
            outletName: d.clientName,
            provinceId: d.provinceId,
            provinceNameKh: d.provinceNameKh,
            districtId: d.districtId,
            districtNameKh: d.districtNameKh,
            communeId: d.communeId,
            communeNameKh: d.communeNameKh,
            items: [{ productId: product._id, brandId: brand._id, brandName: "GANZBERG", productName: "Ganzberg Gold", cases: 5 }],
            reportedAt: d.submittedAt
        }))
    );
    const totalPhotoBytes = uploads.reduce((n, u) => n + u.buffer.length, 0);
    console.log(`seeded ${OUTLETS} outlets × ${PER_OUTLET} photos = ${uploads.length} photos, ${mb(totalPhotoBytes)} in ${ms(t)} ms`);

    // ---------- stages of the outlet export ----------
    t = performance.now();
    const found = await Submission.find(buildSubmissionFilter({}), { files: 1, clientName: 1 }).lean();
    const tQuery = ms(t);

    const keys = found.flatMap((d) => d.files.slice(0, 5).map((f) => f.objectKey));
    t = performance.now();
    const buffers = await mapWithLimit(keys, DOWNLOAD_CONCURRENCY, (key) => downloadObject(key));
    const tDownload = ms(t);
    const perObject = (tDownload / keys.length) * DOWNLOAD_CONCURRENCY;

    t = performance.now();
    const { workbook } = await buildSubmissionsExport({});
    const tBuildTotal = ms(t); // query + downloads + workbook

    t = performance.now();
    const deflated = await workbook.xlsx.writeBuffer();
    const tWrite = ms(t);

    t = performance.now();
    const stored = await workbook.xlsx.writeBuffer({ zip: { compression: "STORE" } });
    const tWriteStore = ms(t);

    console.log("\nOutlet export, stage by stage (in-process):");
    console.log(`  MongoDB query:            ${tQuery} ms`);
    console.log(`  MinIO downloads:          ${tDownload} ms  (${keys.length} photos, ${DOWNLOAD_CONCURRENCY} at a time, ~${Math.round(perObject)} ms each, ${mb(buffers.reduce((n, b) => n + b.length, 0))})`);
    console.log(`  Workbook build (all-in):  ${tBuildTotal} ms  (query + downloads + adding rows/images)`);
    console.log(`  Excel write (deflate):    ${tWrite} ms  -> ${mb(deflated.length)}`);
    console.log(`  Excel write (no zip):     ${tWriteStore} ms  -> ${mb(stored.length)}  (diagnostic only)`);

    // ---------- full HTTP exports ----------
    for (const [label, url] of [
        ["Outlet export (HTTP)", "/admin/submissions/export"],
        ["Stock export (HTTP)", "/admin/stock/reports/export"]
    ]) {
        t = performance.now();
        const res = await api(url, { token });
        const took = ms(t);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body);
        const sheet = wb.worksheets[0];
        console.log(`${label}: ${res.status} in ${took} ms, ${mb(res.body.length)}, ${sheet.rowCount - 1} rows, ${sheet.getImages().length} images`);
    }
} finally {
    await stop();
}
