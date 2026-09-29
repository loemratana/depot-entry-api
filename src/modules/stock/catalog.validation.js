import { z } from "zod";
import { objectId } from "../../utils/validators.js";
import { MEASURE_KEYS } from "./stock.constants.js";

const name = (label, max = 100) =>
    z
        .string({ error: `${label} is required` })
        .transform((value) => value.normalize("NFC").replace(/\s+/g, " ").trim())
        .refine((value) => value.length > 0, { message: `${label} is required` })
        .refine((value) => [...value].length <= max, { message: `${label} must be at most ${max} characters` });

const optionalText = (label, max = 100) =>
    z
        .string()
        .transform((value) => value.normalize("NFC").replace(/\s+/g, " ").trim())
        .refine((value) => [...value].length <= max, { message: `${label} must be at most ${max} characters` });

// Which stock quantities the brand's products ask for (at least one, no repeats)
const measures = z
    .array(z.enum(MEASURE_KEYS, { error: `Must be one of: ${MEASURE_KEYS.join(", ")}` }))
    .min(1, "Choose at least one field")
    .refine((keys) => new Set(keys).size === keys.length, { message: "Each field only once" });

const brandFields = {
    name: name("Brand name"),
    nameKh: optionalText("Khmer name"),
    measures,
    isActive: z.boolean()
};

const atLeastOne = (body, ctx) => {
    if (Object.keys(body).length === 0) ctx.addIssue({ code: "custom", message: "Provide at least one field to update" });
};

const brandId = z.object({ id: objectId("brand id") });
const productId = z.object({ id: objectId("product id") });

export const createBrandSchema = {
    body: z
        .object({
            name: brandFields.name,
            nameKh: brandFields.nameKh.optional(),
            measures: brandFields.measures.optional(),
            isActive: brandFields.isActive.optional()
        })
        .strict()
};

export const updateBrandSchema = {
    params: brandId,
    body: z
        .object({
            name: brandFields.name.optional(),
            nameKh: brandFields.nameKh.optional(),
            measures: brandFields.measures.optional(),
            isActive: brandFields.isActive.optional()
        })
        .strict()
        .superRefine(atLeastOne)
};

export const brandIdSchema = { params: brandId };

export const moveSchema = (idSchema) => ({
    params: idSchema,
    body: z.object({ direction: z.enum(["up", "down"]) }).strict()
});
export const moveBrandSchema = moveSchema(brandId);
export const moveProductSchema = moveSchema(productId);

export const createProductSchema = {
    params: brandId,
    body: z.object({ name: name("Product name", 150), isActive: z.boolean().optional() }).strict()
};

export const updateProductSchema = {
    params: productId,
    body: z
        .object({ name: name("Product name", 150).optional(), isActive: z.boolean().optional() })
        .strict()
        .superRefine(atLeastOne)
};

export const productIdSchema = { params: productId };
