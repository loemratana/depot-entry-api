import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import {
    exportStockReportsSchema,
    listStockReportsSchema,
    stockReportIdSchema
} from "./stock.validation.js";
import * as stockController from "./stock.controller.js";

// /api/public/stock: product catalog for the stock step of the outlet form
export const publicStockRoutes = Router();
publicStockRoutes.get("/catalog", stockController.getCatalog);

// /api/admin/stock
export const adminStockRoutes = Router();
adminStockRoutes.get("/reports", validate(listStockReportsSchema), stockController.listReports);
// Registered before /reports/:id so "export" is not parsed as an id
adminStockRoutes.get("/reports/export", validate(exportStockReportsSchema), stockController.exportReports);
adminStockRoutes.get("/reports/:id", validate(stockReportIdSchema), stockController.getReport);
adminStockRoutes.delete("/reports/:id", validate(stockReportIdSchema), stockController.deleteReport);
