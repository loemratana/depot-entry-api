import { z } from "zod";
import { dateFilter, objectId, paginationQuery, personName, phone } from "../../utils/validators.js";
import { stockItemSchema } from "../stock/stock.validation.js";

// Optional stock quantities sent with the outlet form; multipart sends them as a JSON string
const stockItems = z.preprocess(
    (value) => {
        if (value === undefined || value === "") return undefined;
        if (typeof value !== "string") return value;
        try {
            return JSON.parse(value);
        } catch {
            return value; // reported as "expected array" below
        }
    },
    z
        .array(stockItemSchema)
        .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
            message: "Each product may appear only once"
        })
        .optional()
);

/** Client-generated photo id: letters, digits and dashes (UUID or random hex) */
export const PHOTO_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// Phone clocks drift, so a capture time slightly ahead of the server is tolerated
const CAPTURE_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const EARLIEST_CAPTURE = new Date("2020-01-01T00:00:00Z");

/** GPS reported by the browser for one site photo; matched to its file by photoId */
const sitePhotoGpsSchema = z.object({
    photoId: z.string({ error: "photoId is required" }).regex(PHOTO_ID_PATTERN, "Invalid photoId"),
    latitude: z.number({ error: "latitude must be a number" }).min(-90).max(90),
    longitude: z.number({ error: "longitude must be a number" }).min(-180).max(180),
    // Metres; browsers report the 95% confidence radius
    accuracy: z.number({ error: "accuracy must be a number" }).min(0).max(1_000_000),
    capturedAt: z.iso
        .datetime({ offset: true, error: "capturedAt must be an ISO date-time" })
        .transform((value) => new Date(value))
        .refine((date) => date >= EARLIEST_CAPTURE && date.getTime() <= Date.now() + CAPTURE_CLOCK_SKEW_MS, {
            message: "capturedAt is out of range"
        })
});

// Multipart sends lists as one JSON string
const parseJsonField = (value) => {
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value; // reported as "expected array"
    }
};

const sitePhotoMeta = z.preprocess(
    parseJsonField,
    z
        .array(sitePhotoGpsSchema)
        .max(50)
        .refine((items) => new Set(items.map((i) => i.photoId)).size === items.length, {
            message: "Each photoId may appear only once"
        })
        .optional()
);

export const STAGED_UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

// Photos uploaded while the form was being filled in: only their uploadId is sent.
// Their GPS is in sitePhotoMeta, matched by photoId like the other photos.
const stagedPhotos = z.preprocess(
    parseJsonField,
    z
        .array(
            z.object({
                photoId: z.string({ error: "photoId is required" }).regex(PHOTO_ID_PATTERN, "Invalid photoId"),
                uploadId: z.string({ error: "uploadId is required" }).regex(STAGED_UPLOAD_ID_PATTERN, "Invalid uploadId")
            })
        )
        .max(50)
        .refine((items) => new Set(items.map((i) => i.photoId)).size === items.length, {
            message: "Each photoId may appear only once"
        })
        .refine((items) => new Set(items.map((i) => i.uploadId)).size === items.length, {
            message: "Each uploadId may appear only once"
        })
        .optional()
);

// Optional Sale GB, chosen from the list (saleGbId) or typed (saleGbName); typed names are matched or added
const saleGbName = personName("Sale GB", { min: 2, max: 150 });
const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const saleGbFields = {
    saleGbId: z.preprocess(emptyToUndefined, objectId("saleGbId").optional()),
    saleGbName: z.preprocess(emptyToUndefined, saleGbName.optional())
};

// District / commune typed on the form when it is not in the list
const typedLocationName = (label) =>
    z.preprocess(
        emptyToUndefined,
        z
            .string()
            .trim()
            .min(2, `${label} name must be at least 2 characters`)
            .max(100, `${label} name must be at most 100 characters`)
            .optional()
    );

/** Exactly one of <level>Id (picked) or <level>Name (typed) */
const oneOf = (body, ctx, level, label) => {
    const id = body[`${level}Id`];
    const name = body[`${level}Name`];
    if (id && name) {
        ctx.addIssue({ code: "custom", path: [`${level}Name`], message: `Send either ${level}Id or ${level}Name, not both` });
    } else if (!id && !name) {
        ctx.addIssue({ code: "custom", path: [`${level}Id`], message: `${label} is required` });
    }
};

export const createSubmissionSchema = {
    body: z
        .object({
            clientName: personName("Client name", { min: 2, max: 150 }),
            phone: phone(),
            provinceId: objectId("provinceId"),
            districtId: z.preprocess(emptyToUndefined, objectId("districtId").optional()),
            districtName: typedLocationName("District"),
            communeId: z.preprocess(emptyToUndefined, objectId("communeId").optional()),
            communeName: typedLocationName("Commune"),
            ...saleGbFields,
            stockItems,
            sitePhotoMeta,
            stagedPhotos
        })
        .superRefine(
            (body, ctx) => {
                oneOf(body, ctx, "district", "District");
                oneOf(body, ctx, "commune", "Commune");
            },
            // Also report a missing district/commune when other fields are invalid
            { when: () => true }
        )
};

const LOCATION_FIELDS = ["provinceId", "districtId", "communeId"];

export const updateSubmissionSchema = {
    params: z.object({ id: objectId("submission id") }),
    body: z
        .object({
            clientName: personName("Client name", { min: 2, max: 150 }).optional(),
            phone: phone().optional(),
            provinceId: objectId("provinceId").optional(),
            districtId: objectId("districtId").optional(),
            communeId: objectId("communeId").optional(),
            ...saleGbFields
        })
        .strict()
        .superRefine((body, ctx) => {
            if (Object.keys(body).length === 0) {
                ctx.addIssue({ code: "custom", message: "Provide at least one field to update" });
            }
            // The hierarchy is validated as a whole, so all three change together
            const given = LOCATION_FIELDS.filter((field) => body[field]);
            if (given.length > 0 && given.length < 3) {
                for (const field of LOCATION_FIELDS.filter((f) => !body[f])) {
                    ctx.addIssue({ code: "custom", path: [field], message: "Send province, district and commune together" });
                }
            }
            if (body.saleGbId && body.saleGbName) {
                ctx.addIssue({ code: "custom", path: ["saleGbName"], message: "Send either saleGbId or saleGbName, not both" });
            }
        })
};

export const submissionFileSchema = {
    params: z.object({ id: objectId("submission id"), fileId: objectId("file id") })
};

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export const SORTABLE_FIELDS = ["submittedAt", "clientName", "submissionNo"];

// Shared by the list and the Excel export so both apply identical filters
export const submissionFilterFields = {
    search: z.string().trim().max(100).optional(),
    provinceId: objectId("provinceId").optional(),
    districtId: objectId("districtId").optional(),
    communeId: objectId("communeId").optional(),
    saleGbId: objectId("saleGbId").optional(),
    dateFrom: dateFilter("dateFrom"),
    dateTo: dateFilter("dateTo", { endOfDay: true })
};

const dateRangeIsValid = (query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo;
const dateRangeIssue = { message: "dateFrom must be before or equal to dateTo", path: ["dateTo"] };

export const listSubmissionsSchema = {
    query: z
        .object({
            ...submissionFilterFields,
            ...paginationQuery,
            sortBy: z.enum(SORTABLE_FIELDS).default("submittedAt"),
            sortOrder: z.enum(["asc", "desc"]).default("desc")
        })
        .refine(dateRangeIsValid, dateRangeIssue)
};

export const exportSubmissionsSchema = {
    query: z
        .object({
            ...submissionFilterFields,
            sortBy: z.enum(SORTABLE_FIELDS).default("submittedAt"),
            sortOrder: z.enum(["asc", "desc"]).default("desc")
        })
        .refine(dateRangeIsValid, dateRangeIssue)
};

export const submissionIdSchema = {
    params: z.object({ id: objectId("submission id") })
};
