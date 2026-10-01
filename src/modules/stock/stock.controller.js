import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { STOCK_MEASURES } from "./stock.constants.js";
import * as stockService from "./stock.service.js";
import { exportLimiter } from "../export/export.controller.js";

// ---------- Public ----------

export const getCatalog = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-cache");
    sendSuccess(res, { data: { measures: STOCK_MEASURES, brands: await stockService.listActiveCatalog() } });
});

// ---------- Admin ----------

export const listReports = asyncHandler(async (req, res) => {
    const { data, pagination } = await stockService.listStockReports(req.validated.query);
    sendSuccess(res, { data, pagination });
});

export const getReport = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    sendSuccess(res, { data: await stockService.getStockReport(req.validated.params.id) });
});

export const deleteReport = asyncHandler(async (req, res) => {
    await stockService.deleteStockReport(req.validated.params.id);
    sendSuccess(res, { message: "Stock report deleted" });
});

// Pictures are held in memory, so stock exports share the outlet export queue
export const exportReports = asyncHandler(async (req, res) => {
    await exportLimiter.run(async () => {
        // Built before any headers are sent, so a failure still returns a normal JSON error
        const { workbook } = await stockService.buildStockExport(req.validated.query);
        res.status(200);
        res.set({
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${stockService.stockExportFileName()}"`,
            "Cache-Control": "no-store"
        });
        await workbook.xlsx.write(res);
        res.end();
    });
});
