import { z } from "zod";
import { dateFilter, objectId } from "../../utils/validators.js";

export const dashboardQuerySchema = {
    query: z
        .object({
            provinceId: objectId("provinceId").optional(),
            districtId: objectId("districtId").optional(),
            communeId: objectId("communeId").optional(),
            dateFrom: dateFilter("dateFrom"),
            dateTo: dateFilter("dateTo", { endOfDay: true })
        })
        .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
            message: "dateFrom must be before or equal to dateTo",
            path: ["dateTo"]
        })
};
