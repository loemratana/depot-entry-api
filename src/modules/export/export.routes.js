import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { exportSubmissionsSchema } from "../submission/submission.validation.js";
import * as exportController from "./export.controller.js";

const router = Router();

router.get("/", validate(exportSubmissionsSchema), exportController.exportSubmissions);

export default router;
