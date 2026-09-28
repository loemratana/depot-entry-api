import { z } from "zod";
import { dateFilter, objectId, paginationQuery, personName, phone } from "../../utils/validators.js";

export const createSubmissionSchema = {
    body: z.object({
        clientName: personName("Client name", { min: 2, max: 150 }),
        phone: phone(),
        provinceId: objectId("provinceId"),
        districtId: objectId("districtId"),
        communeId: objectId("communeId"),
        saleGbId: objectId("saleGbId")
    })
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
