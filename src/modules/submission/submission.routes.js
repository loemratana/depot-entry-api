import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { submissionLimiter } from "../../middleware/rateLimit.middleware.js";
import { uploadSubmissionFiles } from "../../middleware/upload.middleware.js";
import {
    createSubmissionSchema,
    listSubmissionsSchema,
    submissionFileSchema,
    submissionIdSchema,
    updateSubmissionSchema
} from "./submission.validation.js";
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
adminSubmissionRoutes.post("/", uploadSubmissionFiles, validate(createSubmissionSchema), submissionController.adminCreateSubmission);
// Registered before /:id so "export" is not parsed as an id
adminSubmissionRoutes.use("/export", exportRoutes);
adminSubmissionRoutes.get("/:id", validate(submissionIdSchema), submissionController.getSubmission);
adminSubmissionRoutes.patch("/:id", validate(updateSubmissionSchema), submissionController.updateSubmission);
adminSubmissionRoutes.delete("/:id", validate(submissionIdSchema), submissionController.deleteSubmission);
// The id is validated before files are received, so a bad id never uploads anything
adminSubmissionRoutes.post(
    "/:id/files",
    validate(submissionIdSchema),
    uploadSubmissionFiles,
    submissionController.addFiles
);
adminSubmissionRoutes.delete("/:id/files/:fileId", validate(submissionFileSchema), submissionController.removeFile);
