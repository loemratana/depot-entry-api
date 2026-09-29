import config from "../../config/env.js";
import asyncHandler from "../../utils/asyncHandler.js";
import { createLimiter } from "../../utils/limiter.js";
import { buildSubmissionsExport, exportFileName } from "./export.service.js";

/*
 * Each export holds its rows and embedded photos (up to EXPORT_MAX_IMAGE_MB) in
 * memory until the file is sent, so exports run one at a time per process.
 * A few more wait their turn; beyond that the API answers 503 + Retry-After.
 */
export const exportLimiter = createLimiter({
    concurrency: config.export.concurrency,
    maxQueue: config.export.maxQueue,
    queueTimeoutMs: config.export.queueTimeoutMs,
    busyMessage: "Too many exports are being prepared right now. Please try again in a moment"
});

export const exportSubmissions = asyncHandler(async (req, res) => {
    await exportLimiter.run(async () => {
        // Built before any headers are sent, so a failure still returns a normal JSON error
        const { workbook } = await buildSubmissionsExport(req.validated.query);

        res.status(200);
        res.set({
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${exportFileName()}"`,
            "Cache-Control": "no-store"
        });

        // The slot is held until the file is sent (or the download is cancelled)
        await workbook.xlsx.write(res);
        res.end();
    });
});
