import { z } from "zod";
import { dateFilter, objectId, paginationQuery } from "../../utils/validators.js";
import { MAX_QUANTITY, MEASURE_KEYS } from "./stock.constants.js";

// Blank means 0; otherwise a whole number between 0 and MAX_QUANTITY
const quantity = z.preprocess(
    (value) => (value === "" || value === null || value === undefined ? 0 : value),
    z.coerce
        .number({ error: "Must be a number" })
        .int("Must be a whole number")
        .min(0, "Cannot be negative")
        .max(MAX_QUANTITY, `Must be at most ${MAX_QUANTITY.toLocaleString("en")}`)
);

export const stockItemSchema = z.object({
    productId: objectId("productId"),
    ...Object.fromEntries(MEASURE_KEYS.map((key) => [key, quantity]))
});

const dateRangeIsValid = (query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo;
const dateRangeIssue = { message: "dateFrom must be before or equal to dateTo", path: ["dateTo"] };

// Shared by the list and the Excel export so both apply identical filters
const filterFields = {
    search: z.string().trim().max(100).optional(),
    provinceId: objectId("provinceId").optional(),
    districtId: objectId("districtId").optional(),
    communeId: objectId("communeId").optional(),
    outletId: objectId("outletId").optional(),
    dateFrom: dateFilter("dateFrom"),
    dateTo: dateFilter("dateTo", { endOfDay: true })
};

export const listStockReportsSchema = {
    query: z.object({ ...filterFields, ...paginationQuery }).refine(dateRangeIsValid, dateRangeIssue)
};

export const exportStockReportsSchema = {
    query: z.object(filterFields).refine(dateRangeIsValid, dateRangeIssue)
};

export const stockReportIdSchema = {
    params: z.object({ id: objectId("stock report id") })
};
