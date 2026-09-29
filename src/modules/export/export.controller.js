import asyncHandler from "../../utils/asyncHandler.js";
import { buildSubmissionsExport, exportFileName } from "./export.service.js";

export const exportSubmissions = asyncHandler(async (req, res) => {
    // Built before any headers are sent, so a failure still returns a normal JSON error
    const { workbook } = await buildSubmissionsExport(req.validated.query);

    res.status(200);
    res.set({
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${exportFileName()}"`,
        "Cache-Control": "no-store"
    });

    await workbook.xlsx.write(res);
    res.end();
});
