import asyncHandler from "../../utils/asyncHandler.js";
import { exportFileName, streamSubmissionsExport } from "./export.service.js";

export const exportSubmissions = asyncHandler(async (req, res) => {
    const fileName = exportFileName();

    res.status(200);
    res.set({
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store"
    });

    // Once streaming starts, errors abort the connection (see error middleware)
    await streamSubmissionsExport(req.validated.query, res);
});
