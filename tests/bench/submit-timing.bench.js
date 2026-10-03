/**
 * Server time for one outlet submission with several photos (test DB/bucket only).
 *   BENCH_PHOTOS=/a.jpg,/b.jpg node tests/bench/submit-timing.bench.js
 */
import fs from "node:fs";
import { api, createLocations, start, stop, submissionForm, validFields } from "../helpers.js";

const photos = (process.env.BENCH_PHOTOS || "").split(",").filter(Boolean).map((p) => fs.readFileSync(p));
const COUNT = Number(process.env.BENCH_COUNT || 8);
await start();
try {
    const fx = await createLocations();
    for (const run of [1, 2, 3]) {
        const form = submissionForm(validFields(fx, { saleGbId: undefined, clientName: `Bench ${run}` }), []);
        const meta = [];
        for (let i = 0; i < COUNT; i++) {
            const photoId = `bench-${run}-${i}-photo`;
            meta.push({ photoId, latitude: 11.55, longitude: 104.92, accuracy: 10, capturedAt: new Date().toISOString() });
            form.append(`sitePhotos[${photoId}]`, new Blob([photos[i % photos.length]], { type: "image/jpeg" }), `p${i}.jpg`);
        }
        form.set("sitePhotoMeta", JSON.stringify(meta));
        const t = performance.now();
        const res = await api("/public/submissions", { method: "POST", form });
        console.log(`run ${run}: ${res.status} in ${Math.round(performance.now() - t)} ms (${COUNT} photos)`);
    }
} finally {
    await stop();
}
