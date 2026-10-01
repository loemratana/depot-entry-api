import { z } from "zod";
import { objectId } from "../../utils/validators.js";
import { PERMISSIONS } from "./permissions.js";

const idParams = (label) => ({ params: z.object({ id: objectId(label) }) });

const roleName = z.string().trim().min(2, "Name must be at least 2 characters").max(60, "Name must be at most 60 characters");
const description = z.string().trim().max(300, "Description must be at most 300 characters");
const permissions = z.array(z.enum(PERMISSIONS, { error: "Unknown permission" })).max(PERMISSIONS.length * 2);

export const roleIdSchema = idParams("role id");

export const createRoleSchema = {
    body: z.object({ name: roleName, description: description.optional(), permissions }).strict()
};

export const updateRoleSchema = {
    ...idParams("role id"),
    body: z
        .object({ name: roleName.optional(), description: description.optional(), permissions: permissions.optional() })
        .strict()
        .refine((body) => Object.keys(body).length > 0, { message: "Provide at least one field to update" })
};

const userName = z.string().trim().min(2, "Name must be at least 2 characters").max(100, "Name must be at most 100 characters");
const email = z.string().trim().toLowerCase().pipe(z.email({ error: "Invalid email address" }));
const password = z
    .string({ error: "Password is required" })
    .min(8, "Password must be at least 8 characters")
    .max(200, "Password must be at most 200 characters");

export const userIdSchema = idParams("user id");

export const createUserSchema = {
    body: z
        .object({ name: userName, email, password, roleId: objectId("roleId"), isActive: z.boolean().optional() })
        .strict()
};

export const updateUserSchema = {
    ...idParams("user id"),
    body: z
        .object({
            name: userName.optional(),
            email: email.optional(),
            roleId: objectId("roleId").optional(),
            isActive: z.boolean().optional()
        })
        .strict()
        .refine((body) => Object.keys(body).length > 0, { message: "Provide at least one field to update" })
};

export const resetPasswordSchema = {
    ...idParams("user id"),
    body: z.object({ password }).strict()
};
