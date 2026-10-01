import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { mapSubmissionsSchema } from "./map.validation.js";
import * as mapController from "./map.controller.js";

// /api/admin/map (admin only; GPS is never exposed on public routes)
export const adminMapRoutes = Router();
adminMapRoutes.get("/submissions", requirePermission("map.view"), validate(mapSubmissionsSchema), mapController.listSubmissionPoints);
