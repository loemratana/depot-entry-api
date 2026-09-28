import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { submissionLimiter } from "../../middleware/rateLimit.middleware.js";
import { uploadSubmissionFiles } from "../../middleware/upload.middleware.js";
import { createSubmissionSchema, listSubmissionsSchema, submissionIdSchema } from "./submission.validation.js";
import * as submissionController from "./submission.controller.js";
import exportRoutes from "../export/export.routes.js";

export const publicSubmissionRoutes = Router();
publicSubmissionRoutes.post(
    "/",
    submissionLimiter,
    uploadSubmissionFiles,
    validate(createSubmissionSchema),
    submissionController.createSubmission
);

export const adminSubmissionRoutes = Router();
adminSubmissionRoutes.get("/", validate(listSubmissionsSchema), submissionController.listSubmissions);
// Registered before /:id so "export" is not parsed as an id
adminSubmissionRoutes.use("/export", exportRoutes);
adminSubmissionRoutes.get("/:id", validate(submissionIdSchema), submissionController.getSubmission);
