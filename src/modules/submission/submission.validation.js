import { z } from "zod";
import { dateFilter, objectId, paginationQuery, personName, phone } from "../../utils/validators.js";

// Optional Sale GB, chosen from the list (saleGbId) or typed (saleGbName); typed names are matched or added
const saleGbName = personName("Sale GB", { min: 2, max: 150 });
const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const saleGbFields = {
    saleGbId: z.preprocess(emptyToUndefined, objectId("saleGbId").optional()),
    saleGbName: z.preprocess(emptyToUndefined, saleGbName.optional())
};

export const createSubmissionSchema = {
    body: z
        .object({
            clientName: personName("Client name", { min: 2, max: 150 }),
            phone: phone(),
            provinceId: objectId("provinceId"),
            districtId: objectId("districtId"),
            communeId: objectId("communeId"),
            ...saleGbFields
        })
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
