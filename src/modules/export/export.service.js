import ExcelJS from "exceljs";
import config from "../../config/env.js";
import { businessDate, toBusinessWallTime } from "../../utils/date.js";
import {
    DOWNLOAD_CONCURRENCY,
    PHOTO_COLUMN_WIDTH,
    plannedPictureBytes,
    COORDINATES_COLUMN_WIDTH,
    ROW_HEIGHT_POINTS,
    addThumbnail,
    mapWithLimit,
    setCoordinates
} from "../../utils/excel-images.js";
import { isPicture, loadExportPicture } from "./exportPicture.service.js";
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
    "files._id": 1,
    "files.originalName": 1,
    "files.objectKey": 1,
    "files.previewKey": 1,
    "files.mimeType": 1,
    "files.size": 1,
    "files.location": 1
};

const MAX_PHOTO_COLUMNS = 5;
const bilingual = (nameKh, nameEn) => (nameEn && nameEn !== nameKh ? `${nameKh} (${nameEn})` : nameKh);

export const exportFileName = () => `client-submissions-${businessDate()}.xlsx`;

// Kept for existing imports
export { imageSize } from "../../utils/excel-images.js";

/**
 * Builds the export workbook with photos embedded next to each client, as
 * small previews (see exportPicture.service). Images are held in memory until
 * the file is written, so the total embedded size is capped
 * (EXPORT_MAX_IMAGE_MB); past the cap, photos are listed by name.
 */
export const buildSubmissionsExport = async (query) => {
    const docs = await Submission.find(buildSubmissionFilter(query), EXPORT_PROJECTION)
        .sort(buildSort(query))
        .maxTimeMS(config.exportQueryTimeoutMs)
        .lean();

    // Decide which files are embedded before downloading anything, to respect the budget
    const budget = config.export.maxImageBytes;
    let planned = 0;
    let budgetReached = false;
    const plans = docs.map((doc) => {
        const photos = [];
        const others = [];
        for (const file of doc.files ?? []) {
            const embeddable = isPicture(file) && photos.length < MAX_PHOTO_COLUMNS;
            const size = plannedPictureBytes(file);
            if (embeddable && planned + size <= budget) {
                photos.push(file);
                planned += size;
            } else {
                if (embeddable) budgetReached = true;
                others.push(file.originalName);
            }
        }
        return { doc, photos, others };
    });

    const photoColumns = Math.max(0, ...plans.map((plan) => plan.photos.length));

    // Download all planned photos a few at a time; a missing object is listed by name instead
    const downloads = plans.flatMap((plan) => plan.photos.map((file) => ({ doc: plan.doc, file })));
    const pictures = await mapWithLimit(downloads, DOWNLOAD_CONCURRENCY, ({ doc, file }) =>
        loadExportPicture(doc._id, file)
    );

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
        // Right after the photos
        { header: "Coordinates", key: "coordinates", width: COORDINATES_COLUMN_WIDTH },
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
        setCoordinates(row.getCell("coordinates"), doc.files);

        const unavailable = [];
        let embedded = 0;
        for (const file of photos) {
            const picture = pictures[downloadIndex++];
            if (!picture) {
                unavailable.push(`${file.originalName} (unavailable)`);
                continue;
            }
            addThumbnail(workbook, sheet, {
                buffer: picture.buffer,
                mimeType: picture.mimeType,
                col: firstPhotoColumn + embedded,
                rowNumber: row.number
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
