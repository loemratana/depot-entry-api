import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
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
adminLocationRoutes.get("/", validate(listLocationsSchema), locationController.listLocations);
adminLocationRoutes.get("/summary", locationController.getSummary);
adminLocationRoutes.get("/template", locationController.downloadTemplate);
adminLocationRoutes.post("/import", validate(importQuerySchema), uploadSpreadsheet, locationController.importLocations);

// POST/PATCH/DELETE /api/admin/locations/{provinces|districts|communes}
for (const level of LOCATION_LEVELS) {
    adminLocationRoutes.post(`/${level}`, validate(createLocationSchema(level)), locationController.createLocation(level));
    adminLocationRoutes.patch(`/${level}/:id`, validate(updateLocationSchema), locationController.updateLocation(level));
    adminLocationRoutes.delete(`/${level}/:id`, validate(deleteLocationSchema), locationController.deleteLocation(level));
}
