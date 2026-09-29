import { z } from "zod";

export const loginSchema = {
    body: z.object({
        email: z.string({ error: "Email is required" }).trim().toLowerCase().pipe(z.email({ error: "Invalid email address" })),
        password: z.string({ error: "Password is required" }).min(1, "Password is required").max(200)
    })
};

const refreshTokenField = z
    .string({ error: "Refresh token is required" })
    .min(20, "Invalid refresh token")
    .max(200, "Invalid refresh token");

export const refreshSchema = {
    body: z.object({ refreshToken: refreshTokenField })
};

// The body is optional so older clients that send nothing keep working
export const logoutSchema = {
    body: z.object({ refreshToken: refreshTokenField.optional() }).optional().default({})
};
