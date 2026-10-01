import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { uploadSpreadsheet } from "../../middleware/upload.middleware.js";
import {
    LOCATION_LEVELS,
    communesQuerySchema,
    createLocationSchema,
    deleteLocationSchema,
    districtsQuerySchema,
    importQuerySchema,
    listLocationsSchema,
    updateLocationSchema
} from "./location.validation.js";
import * as locationController from "./location.controller.js";

const router = Router();

router.get("/provinces", locationController.getProvinces);
router.get("/districts", validate(districtsQuerySchema), locationController.getDistricts);
router.get("/communes", validate(communesQuerySchema), locationController.getCommunes);

export default router;

export const adminLocationRoutes = Router();
const canView = requirePermission("locations.view");
const canManage = requirePermission("locations.manage");
adminLocationRoutes.get("/", canView, validate(listLocationsSchema), locationController.listLocations);
adminLocationRoutes.get("/summary", canView, locationController.getSummary);
adminLocationRoutes.get("/template", requirePermission("locations.import"), locationController.downloadTemplate);
adminLocationRoutes.post(
    "/import",
    requirePermission("locations.import"),
    validate(importQuerySchema),
    uploadSpreadsheet,
    locationController.importLocations
);

// POST/PATCH/DELETE /api/admin/locations/{provinces|districts|communes}
for (const level of LOCATION_LEVELS) {
    adminLocationRoutes.post(`/${level}`, canManage, validate(createLocationSchema(level)), locationController.createLocation(level));
    adminLocationRoutes.patch(`/${level}/:id`, canManage, validate(updateLocationSchema), locationController.updateLocation(level));
    adminLocationRoutes.delete(`/${level}/:id`, canManage, validate(deleteLocationSchema), locationController.deleteLocation(level));
}
