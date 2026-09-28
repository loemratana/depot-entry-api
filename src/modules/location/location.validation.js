import { z } from "zod";
import { objectId, optionalBoolean, personName } from "../../utils/validators.js";
import { MAX_PAGE_SIZE } from "../../utils/pagination.js";

export const districtsQuerySchema = {
    query: z.object({ provinceId: objectId("provinceId") })
};

export const communesQuerySchema = {
    // provinceId is optional; when sent, communes must match both the province and the district
    query: z.object({ districtId: objectId("districtId"), provinceId: objectId("provinceId").optional() })
};

export const importQuerySchema = {
    // The admin page checks first (dryRun=true, the default) and imports on confirmation
    query: z.object({ dryRun: optionalBoolean().transform((value) => value ?? true) })
};

export const listLocationsSchema = {
    query: z.object({
        search: z.string().trim().max(100).optional(),
        provinceId: objectId("provinceId").optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50)
    })
};

// ---------- Admin CRUD ----------

export const LOCATION_LEVELS = ["provinces", "districts", "communes"];

const nameKh = personName("Khmer name", { min: 1, max: 150 });
const nameEn = z
    .string()
    .transform((value) => value.normalize("NFC").replace(/\s+/g, " ").trim())
    .refine((value) => value.length <= 150, { message: "English name must be at most 150 characters" });

const idParams = z.object({ id: objectId("id") });

export const createLocationSchema = (level) => ({
    body: z.object({
        ...(level === "provinces" ? {} : { parentId: objectId(level === "districts" ? "province" : "district") }),
        nameKh,
        nameEn: nameEn.optional()
    })
});

export const updateLocationSchema = {
    params: idParams,
    body: z
        .object({ nameKh: nameKh.optional(), nameEn: nameEn.optional(), isActive: z.boolean().optional() })
        .strict()
        .refine((body) => Object.keys(body).length > 0, { message: "Provide at least one field to update" })
};

export const deleteLocationSchema = { params: idParams };
