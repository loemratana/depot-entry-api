import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { STOCK_MEASURES } from "./stock.constants.js";
import * as stockService from "./stock.service.js";

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

export const exportReports = asyncHandler(async (req, res) => {
    res.status(200);
    res.set({
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${stockService.stockExportFileName()}"`,
        "Cache-Control": "no-store"
    });
    // Once streaming starts, errors abort the connection (see error middleware)
    await stockService.streamStockExport(req.validated.query, res);
});
