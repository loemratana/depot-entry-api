import ExcelJS from "exceljs";
import { businessDate, toBusinessWallTime } from "../../utils/date.js";
import { Submission } from "../submission/submission.model.js";
import { buildSort, buildSubmissionFilter } from "../submission/submission.service.js";

// Only business-facing columns; no internal ids, object keys or idempotency keys
const COLUMNS = [
    { header: "Submission No", key: "submissionNo", width: 24 },
    { header: "Client Name", key: "clientName", width: 28 },
    { header: "Phone", key: "phone", width: 16 },
    { header: "Province", key: "province", width: 28 },
    { header: "District", key: "district", width: 28 },
    { header: "Commune", key: "commune", width: 28 },
    { header: "Sale GB", key: "saleGb", width: 24 },
    { header: "Submitted At", key: "submittedAt", width: 20, style: { numFmt: "yyyy-mm-dd hh:mm" } }
];

const EXPORT_PROJECTION = {
    submissionNo: 1,
    clientName: 1,
    phone: 1,
    provinceNameKh: 1,
    provinceNameEn: 1,
    districtNameKh: 1,
    districtNameEn: 1,
    communeNameKh: 1,
    communeNameEn: 1,
    saleGbName: 1,
    submittedAt: 1
};

const bilingual = (nameKh, nameEn) => (nameEn && nameEn !== nameKh ? `${nameKh} (${nameEn})` : nameKh);

export const exportFileName = () => `client-submissions-${businessDate()}.xlsx`;

/**
 * Streams matching submissions straight from a MongoDB cursor into a
 * streaming workbook writer, so memory use stays flat regardless of row count.
 */
export const streamSubmissionsExport = async (query, outputStream) => {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: outputStream,
        useStyles: true,
        useSharedStrings: false
    });
    workbook.creator = "Client Management System";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Client Submissions", {
        views: [{ state: "frozen", ySplit: 1 }]
    });
    sheet.columns = COLUMNS;
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).commit();

    const cursor = Submission.find(buildSubmissionFilter(query), EXPORT_PROJECTION)
        .sort(buildSort(query))
        .lean()
        .cursor({ batchSize: 500 });

    let rowCount = 0;
    try {
        for await (const doc of cursor) {
            sheet
                .addRow({
                    submissionNo: doc.submissionNo,
                    clientName: doc.clientName,
                    phone: doc.phone,
                    province: bilingual(doc.provinceNameKh, doc.provinceNameEn),
                    district: bilingual(doc.districtNameKh, doc.districtNameEn),
                    commune: bilingual(doc.communeNameKh, doc.communeNameEn),
                    saleGb: doc.saleGbName,
                    // Excel has no time zones; write the business-local wall time
                    submittedAt: toBusinessWallTime(doc.submittedAt)
                })
                .commit();
            rowCount++;
        }
    } finally {
        await cursor.close();
    }

    sheet.autoFilter = { from: "A1", to: { row: 1, column: COLUMNS.length } };
    sheet.commit();
    await workbook.commit();

    return rowCount;
};
