# Excel export performance: analysis

**Status:** analysis only. No application code has been changed yet.
**Scope:** the admin Excel exports, **Outlet** (`GET /api/admin/submissions/export`) and **Stock** (`GET /api/admin/stock/reports/export`).
**Reported problem:** an export of about 200 records with images takes about 1 minute in production.

---

## 1. How the exports work today

```text
HTTP request (admin waits)
  → MongoDB: find matching records (lean, only the needed fields)
  → plan which photos to embed (up to 5 per outlet, max EXPORT_MAX_IMAGE_MB total)
  → MinIO: download the planned photos, 6 at a time
  → ExcelJS: build the workbook in memory (rows + embedded images)
  → ExcelJS: write the .xlsx (zip) to the response
```

| Part | Where |
|---|---|
| Outlet export | `src/modules/export/export.service.js` |
| Stock export | `src/modules/stock/stock.service.js` (`buildStockExport`) |
| Shared image helpers | `src/utils/excel-images.js` (download, concurrency, thumbnail placement) |
| Export queue (one at a time, 503 when full) | `src/modules/export/export.controller.js` (`exportLimiter`) |
| Excel library | `exceljs` (in-memory `Workbook`, needed for embedded images) |
| Photo storage | MinIO, the original uploaded file (no preview or thumbnail copies exist) |
| Photo size on upload | Shrunk in the browser to at most **1600 px**, JPEG quality 0.8 (`shadcn-admin/src/features/submit/lib/image.ts`) |
| Displayed size in Excel | **110 × 80 px** thumbnail per cell |

Facts that correct earlier assumptions:

- **Downloads are not sequential.** They already run 6 at a time (`DOWNLOAD_CONCURRENCY`).
- **MongoDB is not the bottleneck.** The query fetches only the needed fields with `.lean()`.
- **Redis is not part of the project.** No Redis dependency, configuration or container exists.
- **No image-processing library is installed** (no Sharp), and only the original photos are stored.

---

## 2. Measurement

### Setup

- Local machine, local Docker MongoDB and MinIO, **test** database and bucket only.
- 200 outlets × 3 photos each = **600 photos, 274.6 MB**.
- The photos are realistic 1600 × 1200 JPEGs at quality 0.8, about **470 KB each**, the same as phones upload.
- Each outlet also has one stock report.

### Results

| Stage (Outlet export) | Time | Notes |
|---|---|---|
| MongoDB query | **21 ms** | |
| MinIO downloads | **2,205 ms** | 600 photos, 6 at a time, about 22 ms each |
| Workbook build | **~1.7 s** | Includes the query and downloads again, plus adding rows and images |
| **Write .xlsx (zip DEFLATE)** | **29,719 ms** | **Bottleneck.** Output 199.5 MB |
| Write .xlsx without compression (diagnostic only) | 1,589 ms | Output 200.2 MB, the same size |

| End to end (HTTP, as an admin sees it) | Time | File | Images |
|---|---|---|---|
| Outlet export | **26.7 s** | 199.5 MB | 436 of 600 (stopped at the 200 MB image limit) |
| Stock export (1 photo per outlet) | **13.1 s** | 91.5 MB | 200 |

These are local timings. Production adds the network path to MinIO (see 3.3), so it is slower there.

---

## 3. Root causes

### 3.1 Re-compressing JPEGs while writing the file (about 30 s)

An `.xlsx` file is a zip archive. When it is written, ExcelJS compresses every embedded JPEG with DEFLATE. JPEGs are already compressed, so this costs about 30 s of CPU and saves nothing (199.5 MB with compression vs 200.2 MB without). **This is the single largest cost.**

### 3.2 Embedding full-size photos for 110 × 80 px thumbnails

Each 1600 px, ~470 KB photo is embedded as-is, although Excel displays it at 110 × 80 px. This causes:

- **Very large files:** 200 MB for 200 outlets.
- **Missing photos:** the 200 MB memory cap (`EXPORT_MAX_IMAGE_MB`) is reached, so the rest are listed by name instead.
- **More work for 3.1**, and more memory.

A 240 × 180 thumbnail (2× the display size, sharp on high-resolution screens) is about 10–20 KB.

### 3.3 Production path to MinIO (to verify on the VPS)

Production uses `MINIO_ENDPOINT=minio.gbadminsystem.online`, port 443, SSL. If MinIO runs on the same server as the API, every photo download still goes out through the public HTTPS address and back, instead of a direct local connection. Over hundreds of photos this adds up. It has not been measured from the VPS yet.

### 3.4 The request waits for the whole export

The admin's browser waits for the whole job, and the export queue allows one export at a time. A slow export blocks the next one.

---

## 4. Recommended changes

In order of impact.

### 4.1 Write the .xlsx without re-compressing (quick win)

Write the file with zip `STORE` (no compression). This is a one-line change in each export.

- **Measured:** 29.7 s → 1.6 s for the write stage.
- File size is unchanged, because the images are already compressed.

### 4.2 Embed thumbnails, not originals

- **Add Sharp** to resize photos to about 240 × 180 at JPEG quality 70.
- **New photos:** create a thumbnail when the photo is uploaded and store it next to the original in MinIO, e.g. `submissions/{id}/{photo}.thumb.jpg`.
- **Existing photos:** create the thumbnail the first time an export needs it, store it, and record its key on the file entry so it is reused next time.
- **Originals are never changed or deleted.**
- **Expected (not yet measured):** export files drop from ~200 MB to roughly 10 MB, every photo can be embedded, and downloads and memory shrink to match.

### 4.3 Background export jobs (the request returns immediately)

Without Redis, use MongoDB as the job store, with a separate worker process.

```text
Admin → POST /api/admin/exports → job saved (status: queued) → returns { jobId }
Worker (separate process) → claims the next queued job (atomic update)
   → MongoDB (cursor, batches of 50) → MinIO thumbnails (limited concurrency)
   → ExcelJS → upload to MinIO exports/{jobId}/… → status: completed
Admin UI polls GET /api/admin/exports/:jobId every 2–3 s → Download
```

| Endpoint | Purpose |
|---|---|
| `POST /api/admin/exports` | Body `{ type: "outlets" \| "stock", filters }`. Validates, creates the job, returns `{ jobId, status: "queued" }` |
| `GET /api/admin/exports/:jobId` | `{ status, progress, processed, total }`. Status is `queued`, `processing`, `completed` or `failed` |
| `GET /api/admin/exports/:jobId/download` | Streams the finished file from MinIO through the API |

Design notes:

- **Worker:** the same codebase with a different start command (e.g. `npm run worker`). It runs as its own container next to the API and can be restarted on its own.
- **Job logic is separate from the queue mechanism**, so it can later move to Redis + BullMQ without rewriting the export itself.
- **Progress** is written to the job record about every 10%. Nothing large (rows, images, files) is kept in the job store.
- **Security:**
  - Only the admin who started the job can see or download it, and only with the export permission (`outlets.export` / `stock.export`).
  - The file is streamed through the API, so MinIO addresses and credentials are never exposed.
- **Cleanup:**
  - Export files and job records are deleted after 24 hours: files by a periodic sweep in the worker, job records by a MongoDB TTL index.
  - A failed job deletes its partial file.
  - Only `exports/` objects are ever deleted, never uploaded photos.

### 4.4 Admin UI

Clicking Export starts the job and shows "Preparing export… 45%". The page stays usable while it runs, and a **Download** button appears when the file is ready.

### 4.5 Production setting (no code change)

If MinIO runs on the same VPS, point the API at MinIO's internal address (for example `127.0.0.1:9000` or the Docker network name) instead of the public HTTPS domain. Compare both on the VPS first.

---

## 5. Decisions needed

1. **Job queue:** MongoDB plus a separate worker process (recommended, nothing new to install), or add Redis now and use BullMQ?
2. **Thumbnails:** generate with Sharp, at upload and on first export for older photos (recommended), or keep embedding full-size photos?
3. **Quick win first:** apply 4.1 (no re-compression) on its own right away? It is the biggest gain for the least risk.

---

## 6. How to reproduce the measurement

The benchmark uses the **test** database and bucket from `tests/helpers.js`, never real data. MongoDB and MinIO must be running (`npm run db:up`).

```bash
cd backend-api
BENCH_PHOTOS="/path/photo1.jpg,/path/photo2.jpg" \
BENCH_OUTLETS=200 BENCH_PHOTOS_PER_OUTLET=3 \
node tests/bench/export-timing.bench.js
```

- `BENCH_PHOTOS`: one or more real JPEGs (about 1600 px, like phone uploads), reused across outlets.
- The script prints the time of each stage (query, downloads, workbook, write with and without compression) and the full HTTP time and file size of both exports.

Rerun it after each change above to record before and after numbers.
