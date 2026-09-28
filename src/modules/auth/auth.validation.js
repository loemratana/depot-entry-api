import { z } from "zod";

export const loginSchema = {
    body: z.object({
        email: z.string({ error: "Email is required" }).trim().toLowerCase().pipe(z.email({ error: "Invalid email address" })),
        password: z.string({ error: "Password is required" }).min(1, "Password is required").max(200)
    })
};
