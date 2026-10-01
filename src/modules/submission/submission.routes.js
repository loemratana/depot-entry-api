import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { submissionLimiter } from "../../middleware/rateLimit.middleware.js";
import { uploadSubmissionFiles, uploadSubmissionWithSitePhotos } from "../../middleware/upload.middleware.js";
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
    uploadSubmissionWithSitePhotos,
    validate(createSubmissionSchema),
    submissionController.createSubmission
);

export const adminSubmissionRoutes = Router();
// Permissions are checked before any file is received
adminSubmissionRoutes.get("/", requirePermission("outlets.view"), validate(listSubmissionsSchema), submissionController.listSubmissions);
adminSubmissionRoutes.post(
    "/",
    requirePermission("outlets.create"),
    uploadSubmissionFiles,
    validate(createSubmissionSchema),
    submissionController.adminCreateSubmission
);
// Registered before /:id so "export" is not parsed as an id
adminSubmissionRoutes.use("/export", requirePermission("outlets.export"), exportRoutes);
adminSubmissionRoutes.get("/:id", requirePermission("outlets.view"), validate(submissionIdSchema), submissionController.getSubmission);
adminSubmissionRoutes.patch("/:id", requirePermission("outlets.update"), validate(updateSubmissionSchema), submissionController.updateSubmission);
adminSubmissionRoutes.delete("/:id", requirePermission("outlets.delete"), validate(submissionIdSchema), submissionController.deleteSubmission);
// The id is validated before files are received, so a bad id never uploads anything
adminSubmissionRoutes.post(
    "/:id/files",
    requirePermission("outlets.files"),
    validate(submissionIdSchema),
    uploadSubmissionFiles,
    submissionController.addFiles
);
adminSubmissionRoutes.delete(
    "/:id/files/:fileId",
    requirePermission("outlets.files"),
    validate(submissionFileSchema),
    submissionController.removeFile
);
