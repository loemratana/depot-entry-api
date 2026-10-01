import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { uploadBrandLogo } from "../../middleware/upload.middleware.js";
import {
    exportStockReportsSchema,
    listStockReportsSchema,
    stockReportIdSchema
} from "./stock.validation.js";
import {
    brandIdSchema,
    createBrandSchema,
    createProductSchema,
    moveBrandSchema,
    moveProductSchema,
    productIdSchema,
    updateBrandSchema,
    updateProductSchema
} from "./catalog.validation.js";
import * as stockController from "./stock.controller.js";
import * as catalogController from "./catalog.controller.js";

// /api/public/stock: product catalog for the stock step of the outlet form
export const publicStockRoutes = Router();
publicStockRoutes.get("/catalog", stockController.getCatalog);
publicStockRoutes.get("/brands/:id/logo", validate(brandIdSchema), catalogController.getBrandLogo);

// /api/admin/stock
export const adminStockRoutes = Router();
const canViewStock = requirePermission("stock.view");
adminStockRoutes.get("/reports", canViewStock, validate(listStockReportsSchema), stockController.listReports);
// Registered before /reports/:id so "export" is not parsed as an id
adminStockRoutes.get("/reports/export", requirePermission("stock.export"), validate(exportStockReportsSchema), stockController.exportReports);
adminStockRoutes.get("/reports/:id", canViewStock, validate(stockReportIdSchema), stockController.getReport);
adminStockRoutes.delete("/reports/:id", requirePermission("stock.delete"), validate(stockReportIdSchema), stockController.deleteReport);

// Brands & products shown on the stock form
const canManageCatalog = requirePermission("catalog.manage");
adminStockRoutes.get("/brands", requirePermission("catalog.view", "catalog.manage"), catalogController.listBrands);
adminStockRoutes.post("/brands", canManageCatalog, validate(createBrandSchema), catalogController.createBrand);
adminStockRoutes.patch("/brands/:id", canManageCatalog, validate(updateBrandSchema), catalogController.updateBrand);
adminStockRoutes.delete("/brands/:id", canManageCatalog, validate(brandIdSchema), catalogController.deleteBrand);
adminStockRoutes.post("/brands/:id/move", canManageCatalog, validate(moveBrandSchema), catalogController.moveBrand);
// The id is validated before the image is received
adminStockRoutes.put("/brands/:id/logo", canManageCatalog, validate(brandIdSchema), uploadBrandLogo, catalogController.uploadLogo);
adminStockRoutes.delete("/brands/:id/logo", canManageCatalog, validate(brandIdSchema), catalogController.removeLogo);
adminStockRoutes.post("/brands/:id/products", canManageCatalog, validate(createProductSchema), catalogController.createProduct);
adminStockRoutes.patch("/products/:id", canManageCatalog, validate(updateProductSchema), catalogController.updateProduct);
adminStockRoutes.delete("/products/:id", canManageCatalog, validate(productIdSchema), catalogController.deleteProduct);
adminStockRoutes.post("/products/:id/move", canManageCatalog, validate(moveProductSchema), catalogController.moveProduct);
