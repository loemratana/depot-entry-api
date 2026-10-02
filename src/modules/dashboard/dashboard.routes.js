import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { dashboardQuerySchema } from "./dashboard.validation.js";
import * as dashboardController from "./dashboard.controller.js";

// /api/admin/dashboard
export const adminDashboardRoutes = Router();
adminDashboardRoutes.get("/", requirePermission("outlets.view"), validate(dashboardQuerySchema), dashboardController.dashboard);
