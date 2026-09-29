import ExcelJS from "exceljs";
import config from "../../config/env.js";
import { BUCKET, minioClient } from "../../config/minio.js";
import { businessDate, toBusinessWallTime } from "../../utils/date.js";
import { Submission } from "../submission/submission.model.js";
import { buildSort, buildSubmissionFilter } from "../submission/submission.service.js";

// Only business-facing columns; no internal ids, object keys or idempotency keys
const COLUMNS = [
    { header: "Client Name", key: "clientName", width: 28 },
    { header: "Phone", key: "phone", width: 16 },
    { header: "Province", key: "province", width: 28 },
    { header: "District", key: "district", width: 28 },
    { header: "Commune", key: "commune", width: 28 },
    { header: "Submitted At", key: "submittedAt", width: 20, style: { numFmt: "yyyy-mm-dd hh:mm" } }
];

const EXPORT_PROJECTION = {
    clientName: 1,
    phone: 1,
    provinceNameKh: 1,
    provinceNameEn: 1,
    districtNameKh: 1,
    districtNameEn: 1,
    communeNameKh: 1,
    communeNameEn: 1,
    submittedAt: 1,
    "files.originalName": 1,
    "files.objectKey": 1,
    "files.mimeType": 1,
    "files.size": 1
};

// Formats Excel can display; others (WebP, PDF) are listed by name
const EMBEDDABLE = { "image/jpeg": "jpeg", "image/png": "png" };
const MAX_PHOTO_COLUMNS = 5;
const DOWNLOAD_CONCURRENCY = 6;

// Thumbnail box per cell, in pixels; rows and photo columns are sized to fit it
const THUMB_WIDTH = 110;
const THUMB_HEIGHT = 80;
const PHOTO_COLUMN_WIDTH = 17; // Excel character units ≈ 124 px
const ROW_HEIGHT_POINTS = 66; // ≈ 88 px

const bilingual = (nameKh, nameEn) => (nameEn && nameEn !== nameKh ? `${nameKh} (${nameEn})` : nameKh);

export const exportFileName = () => `client-submissions-${businessDate()}.xlsx`;

/** Width/height from the PNG or JPEG header, so thumbnails keep their proportions */
export const imageSize = (buffer) => {
    if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) break;
            const marker = buffer[offset + 1];
            const length = buffer.readUInt16BE(offset + 2);
            // Start-of-frame markers carry the dimensions
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
            }
            offset += 2 + length;
        }
    }
    return null;
};

const fitThumbnail = (size) => {
    if (!size?.width || !size?.height) return { width: THUMB_WIDTH, height: THUMB_HEIGHT };
    const scale = Math.min(THUMB_WIDTH / size.width, THUMB_HEIGHT / size.height, 1);
    return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
};

const downloadObject = async (objectKey) => {
    const stream = await minioClient.getObject(BUCKET, objectKey);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
};

/** Runs `worker` over `items` with at most `limit` in flight */
const mapWithLimit = async (items, limit, worker) => {
    const results = new Array(items.length);
    let next = 0;
    const run = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
};

/**
 * Builds the export workbook with photos embedded next to each client.
 * Images are held in memory until the file is written, so the total embedded
 * size is capped (EXPORT_MAX_IMAGE_MB); past the cap, photos are listed by name.
 */
export const buildSubmissionsExport = async (query) => {
    const docs = await Submission.find(buildSubmissionFilter(query), EXPORT_PROJECTION)
        .sort(buildSort(query))
        .lean();

    // Decide which files are embedded before downloading anything, to respect the budget
    const budget = config.export.maxImageBytes;
    let planned = 0;
    let budgetReached = false;
    const plans = docs.map((doc) => {
        const photos = [];
        const others = [];
        for (const file of doc.files ?? []) {
            const embeddable = EMBEDDABLE[file.mimeType] && photos.length < MAX_PHOTO_COLUMNS;
            if (embeddable && planned + file.size <= budget) {
                photos.push(file);
                planned += file.size;
            } else {
                if (embeddable) budgetReached = true;
                others.push(file.originalName);
            }
        }
        return { doc, photos, others };
    });

    const photoColumns = Math.max(0, ...plans.map((plan) => plan.photos.length));

    // Download all planned photos a few at a time; a missing object is listed by name instead
    const downloads = plans.flatMap((plan, row) => plan.photos.map((file) => ({ row, file })));
    const buffers = await mapWithLimit(downloads, DOWNLOAD_CONCURRENCY, async ({ file }) => {
        try {
            return await downloadObject(file.objectKey);
        } catch {
            return null;
        }
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Client Management System";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Client Submissions", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = [
        ...COLUMNS,
        ...Array.from({ length: photoColumns }, (_, i) => ({
            header: `Photo ${i + 1}`,
            key: `photo${i + 1}`,
            width: PHOTO_COLUMN_WIDTH
        })),
        { header: "Other files", key: "otherFiles", width: 40 }
    ];
    sheet.getRow(1).font = { bold: true };

    const firstPhotoColumn = COLUMNS.length; // zero-based index for image anchors
    let downloadIndex = 0;

    plans.forEach(({ doc, photos, others }) => {
        // The row is added first; images are then anchored to its real row number
        const row = sheet.addRow({
            clientName: doc.clientName,
            phone: doc.phone,
            province: bilingual(doc.provinceNameKh, doc.provinceNameEn),
            district: bilingual(doc.districtNameKh, doc.districtNameEn),
            commune: bilingual(doc.communeNameKh, doc.communeNameEn),
            // Excel has no time zones; write the business-local wall time
            submittedAt: toBusinessWallTime(doc.submittedAt)
        });

        const unavailable = [];
        let embedded = 0;
        for (const file of photos) {
            const buffer = buffers[downloadIndex++];
            if (!buffer) {
                unavailable.push(`${file.originalName} (unavailable)`);
                continue;
            }
            const imageId = workbook.addImage({ buffer, extension: EMBEDDABLE[file.mimeType] });
            const { width, height } = fitThumbnail(imageSize(buffer));
            sheet.addImage(imageId, {
                // Zero-based anchor; small offsets keep the picture inside its cell borders
                tl: { col: firstPhotoColumn + embedded + 0.05, row: row.number - 1 + 0.05 },
                ext: { width, height },
                editAs: "oneCell"
            });
            embedded++;
        }

        // One file name per line inside the cell
        row.getCell("otherFiles").value = [...others, ...unavailable].join(String.fromCharCode(10)) || null;
        if (embedded > 0) row.height = ROW_HEIGHT_POINTS;
        row.alignment = { vertical: "middle", wrapText: true };
    });

    sheet.autoFilter = { from: "A1", to: { row: 1, column: sheet.columns.length } };

    if (budgetReached) {
        const note = workbook.addWorksheet("Notes");
        note.getColumn(1).width = 100;
        note.addRow([
            `Some photos are listed by name in "Other files" instead of shown, because this export ` +
                `reached the ${Math.round(budget / 1024 / 1024)} MB image limit. Narrow the filters to export fewer clients.`
        ]);
    }

    return { workbook, rowCount: docs.length };
};
