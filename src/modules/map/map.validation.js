import { z } from "zod";
import { objectId } from "../../utils/validators.js";
import { submissionFilterFields } from "../submission/submission.validation.js";

const { provinceId, districtId, communeId, dateFrom, dateTo } = submissionFilterFields;

export const mapSubmissionsSchema = {
    query: z
        .object({
            provinceId,
            districtId,
            communeId,
            // Same meaning as on the outlet list: the date the outlet was submitted
            dateFrom,
            dateTo,
            // "View on map" from an outlet's details shows only that outlet
            submissionId: objectId("submissionId").optional()
        })
        .refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo, {
            message: "dateFrom must be before or equal to dateTo",
            path: ["dateTo"]
        })
};
