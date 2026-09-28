import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { createSaleSchema, listSalesSchema, updateSaleSchema } from "./sale.validation.js";
import * as saleController from "./sale.controller.js";

export const publicSaleRoutes = Router();
publicSaleRoutes.get("/", saleController.getPublicSales);

export const adminSaleRoutes = Router();
adminSaleRoutes.get("/", validate(listSalesSchema), saleController.listSales);
adminSaleRoutes.post("/", validate(createSaleSchema), saleController.createSale);
adminSaleRoutes.patch("/:id", validate(updateSaleSchema), saleController.updateSale);
