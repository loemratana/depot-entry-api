import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
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
adminStockRoutes.get("/reports", validate(listStockReportsSchema), stockController.listReports);
// Registered before /reports/:id so "export" is not parsed as an id
adminStockRoutes.get("/reports/export", validate(exportStockReportsSchema), stockController.exportReports);
adminStockRoutes.get("/reports/:id", validate(stockReportIdSchema), stockController.getReport);
adminStockRoutes.delete("/reports/:id", validate(stockReportIdSchema), stockController.deleteReport);

// Brands & products shown on the stock form
adminStockRoutes.get("/brands", catalogController.listBrands);
adminStockRoutes.post("/brands", validate(createBrandSchema), catalogController.createBrand);
adminStockRoutes.patch("/brands/:id", validate(updateBrandSchema), catalogController.updateBrand);
adminStockRoutes.delete("/brands/:id", validate(brandIdSchema), catalogController.deleteBrand);
adminStockRoutes.post("/brands/:id/move", validate(moveBrandSchema), catalogController.moveBrand);
// The id is validated before the image is received
adminStockRoutes.put("/brands/:id/logo", validate(brandIdSchema), uploadBrandLogo, catalogController.uploadLogo);
adminStockRoutes.delete("/brands/:id/logo", validate(brandIdSchema), catalogController.removeLogo);
adminStockRoutes.post("/brands/:id/products", validate(createProductSchema), catalogController.createProduct);
adminStockRoutes.patch("/products/:id", validate(updateProductSchema), catalogController.updateProduct);
adminStockRoutes.delete("/products/:id", validate(productIdSchema), catalogController.deleteProduct);
adminStockRoutes.post("/products/:id/move", validate(moveProductSchema), catalogController.moveProduct);
