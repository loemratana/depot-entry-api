import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { createSaleSchema, listSalesSchema, updateSaleSchema } from "./sale.validation.js";
import * as saleController from "./sale.controller.js";

export const publicSaleRoutes = Router();
publicSaleRoutes.get("/", saleController.getPublicSales);

export const adminSaleRoutes = Router();
// Outlet filters and the outlet form list Sale GB names too
adminSaleRoutes.get("/", requirePermission("outlets.view", "sales.manage"), validate(listSalesSchema), saleController.listSales);
adminSaleRoutes.post("/", requirePermission("sales.manage"), validate(createSaleSchema), saleController.createSale);
adminSaleRoutes.patch("/:id", requirePermission("sales.manage"), validate(updateSaleSchema), saleController.updateSale);
