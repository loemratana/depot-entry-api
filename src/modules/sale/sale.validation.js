import { z } from "zod";
import { objectId, optionalBoolean, paginationQuery, personName, phone } from "../../utils/validators.js";

const code = z
    .string()
    .trim()
    .toUpperCase()
    .max(30, "Code must be at most 30 characters")
    .regex(/^[A-Z0-9_-]*$/, "Code may only contain letters, numbers, - and _");

// Empty strings from forms mean "not set"
const emptyToUndefined = (schema) =>
    z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional());

const emptyToNull = (schema) =>
    z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? null : value), schema.nullable().optional());

export const listSalesSchema = {
    query: z.object({
        search: z.string().trim().max(100).optional(),
        isActive: optionalBoolean(),
        ...paginationQuery
    })
};

export const createSaleSchema = {
    body: z.object({
        name: personName("Name", { min: 1, max: 150 }),
        code: emptyToUndefined(code),
        phone: emptyToUndefined(phone()),
        isActive: z.boolean().optional()
    })
};

export const updateSaleSchema = {
    params: z.object({ id: objectId("Sale GB id") }),
    body: z
        .object({
            name: personName("Name", { min: 1, max: 150 }).optional(),
            code: emptyToNull(code),
            phone: emptyToNull(phone()),
            isActive: z.boolean().optional()
        })
        .strict()
        .refine((body) => Object.keys(body).length > 0, { message: "Provide at least one field to update" })
};
