import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requirePermission } from "../../middleware/auth.middleware.js";
import {
    uploadStagedPhoto,
    uploadSubmissionFiles,
    uploadSubmissionWithSitePhotos
} from "../../middleware/upload.middleware.js";
import {
    createSubmissionSchema,
    listSubmissionsSchema,
    outletStockSchema,
    submissionFileSchema,
    submissionIdSchema,
    updateSubmissionSchema
} from "./submission.validation.js";
import * as submissionController from "./submission.controller.js";
import exportRoutes from "../export/export.routes.js";

export const publicSubmissionRoutes = Router();
publicSubmissionRoutes.post(
    "/",
    uploadSubmissionWithSitePhotos,
    validate(createSubmissionSchema),
    submissionController.createSubmission
);

// A photo uploaded while the form is being filled in; Submit then sends only its uploadId
publicSubmissionRoutes.post("/photos", uploadStagedPhoto, submissionController.stageSubmissionPhoto);

export const adminSubmissionRoutes = Router();
// Permissions are checked before any file is received
adminSubmissionRoutes.get("/", requirePermission("outlets.view"), validate(listSubmissionsSchema), submissionController.listSubmissions);
// Same form as the public one: files, GPS site photos and stock
adminSubmissionRoutes.post(
    "/",
    requirePermission("outlets.create"),
    uploadSubmissionWithSitePhotos,
    validate(createSubmissionSchema),
    submissionController.adminCreateSubmission
);
adminSubmissionRoutes.post(
    "/photos",
    requirePermission("outlets.create"),
    uploadStagedPhoto,
    submissionController.adminStageSubmissionPhoto
);
// Registered before /:id so "export" is not parsed as an id
adminSubmissionRoutes.use("/export", requirePermission("outlets.export"), exportRoutes);
adminSubmissionRoutes.get("/:id", requirePermission("outlets.view"), validate(submissionIdSchema), submissionController.getSubmission);
adminSubmissionRoutes.patch("/:id", requirePermission("outlets.update"), validate(updateSubmissionSchema), submissionController.updateSubmission);
adminSubmissionRoutes.delete("/:id", requirePermission("outlets.delete"), validate(submissionIdSchema), submissionController.deleteSubmission);
// Edit the outlet's stock, or add it again after it was deleted
adminSubmissionRoutes.put("/:id/stock", requirePermission("stock.update"), validate(outletStockSchema), submissionController.setOutletStock);
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
