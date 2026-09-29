/**
 * Memory benchmark for concurrent Excel exports with embedded photos.
 * Uses the TEST database and bucket (see tests/helpers.js), never development data.
 *
 *   node tests/bench/export-memory.bench.js
 *
 * Creates OUTLETS outlets with one PHOTO_KB photo each, then fires CONCURRENT
 * export requests at once and reports the process's peak RSS/heap while they run.
 */
import crypto from "node:crypto";
import { FILES, api, createAdmin, createLocations, login, start, stop, submissionForm, validFields } from "../helpers.js";

const OUTLETS = Number(process.env.BENCH_OUTLETS || 40);
const PHOTO_KB = Number(process.env.BENCH_PHOTO_KB || 400);
const CONCURRENT = Number(process.env.BENCH_CONCURRENT || 4);

// A JPEG header followed by random bytes: passes the signature check, cannot be compressed away
const photo = async () => {
    const header = Buffer.from(await FILES.jpg().arrayBuffer());
    return new Blob([Buffer.concat([header, crypto.randomBytes(PHOTO_KB * 1024 - header.length)])], { type: "image/jpeg" });
};

await start();
try {
    await createAdmin();
    const fx = await createLocations();
    const token = await login();

    process.env.MAX_FILE_SIZE_MB = "1";
    for (let i = 0; i < OUTLETS; i++) {
        const res = await api("/admin/submissions", {
            method: "POST",
            token,
            form: submissionForm(validFields(fx, { saleGbId: undefined, clientName: `Bench ${i}`, phone: `0120000${String(i).padStart(3, "0")}` }), [["p.jpg", await photo()]])
        });
        if (res.status !== 201) throw new Error(`seed ${i}: ${res.status} ${JSON.stringify(res.body)}`);
    }

    global.gc?.();
    const baseline = process.memoryUsage();
    let peakRss = baseline.rss;
    let peakHeap = baseline.heapUsed;
    const sampler = setInterval(() => {
        const m = process.memoryUsage();
        peakRss = Math.max(peakRss, m.rss);
        peakHeap = Math.max(peakHeap, m.heapUsed + m.external + m.arrayBuffers);
    }, 20);

    const started = Date.now();
    const results = await Promise.all(
        Array.from({ length: CONCURRENT }, async () => {
            const t = Date.now();
            const res = await api("/admin/submissions/export", { token });
            return { status: res.status, ms: Date.now() - t, bytes: Buffer.isBuffer(res.body) ? res.body.length : 0 };
        })
    );
    clearInterval(sampler);

    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    console.log(`outlets=${OUTLETS} photo=${PHOTO_KB}KB concurrent=${CONCURRENT}`);
    console.log(`responses: ${results.map((r) => `${r.status} ${r.ms}ms ${mb(r.bytes)}MB`).join(" | ")}`);
    console.log(`total wall time: ${Date.now() - started}ms`);
    console.log(`peak RSS: ${mb(peakRss)} MB (baseline ${mb(baseline.rss)} MB, +${mb(peakRss - baseline.rss)} MB)`);
    console.log(`peak heap+buffers: ${mb(peakHeap)} MB (baseline ${mb(baseline.heapUsed + baseline.external + baseline.arrayBuffers)} MB)`);
} finally {
    await stop();
}
