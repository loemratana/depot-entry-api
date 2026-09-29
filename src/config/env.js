import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const bool = (fallback) =>
    z
        .enum(["true", "false"])
        .optional()
        .transform((value) => (value === undefined ? fallback : value === "true"));

const int = (fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) =>
    z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z
    .object({
        NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
        PORT: int(5000, { min: 1, max: 65535 }),

        MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
        MONGODB_MAX_POOL_SIZE: int(20, { min: 1 }),
        MONGODB_MIN_POOL_SIZE: int(2, { min: 0 }),

        CORS_ORIGIN: z.string().default("http://localhost:5173"),

        JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
        JWT_EXPIRES_IN: z.string().default("8h"),

        ADMIN_NAME: z.string().optional(),
        ADMIN_EMAIL: z.string().optional(),
        ADMIN_PASSWORD: z.string().optional(),

        MINIO_ENDPOINT: z.string().default("localhost"),
        MINIO_PORT: int(9000, { min: 1, max: 65535 }),
        MINIO_USE_SSL: bool(false),
        MINIO_ACCESS_KEY: z.string().min(1, "MINIO_ACCESS_KEY is required"),
        MINIO_SECRET_KEY: z.string().min(1, "MINIO_SECRET_KEY is required"),
        MINIO_BUCKET: z.string().min(3).default("client-documents"),
        MINIO_REGION: z.string().default("us-east-1"),
        FILE_URL_EXPIRY_SECONDS: int(900, { min: 60, max: 7 * 24 * 3600 }),

        MAX_FILES_PER_SUBMISSION: int(10, { min: 1, max: 50 }),
        MAX_FILE_SIZE_MB: int(10, { min: 1, max: 100 }),
        ALLOWED_FILE_TYPES: z.string().default("image/jpeg,image/png,image/webp,application/pdf"),
        // Total size of photos embedded in one Excel export (they are held in memory while it is built)
        EXPORT_MAX_IMAGE_MB: int(200, { min: 1, max: 2000 }),

        PUBLIC_SUBMISSION_RATE_LIMIT_WINDOW_MINUTES: int(15, { min: 1 }),
        PUBLIC_SUBMISSION_RATE_LIMIT_MAX: int(20, { min: 1 }),
        PUBLIC_API_RATE_LIMIT_MAX: int(300, { min: 1 }),
        LOGIN_RATE_LIMIT_MAX: int(10, { min: 1 }),
        TRUST_PROXY: z.string().default("false"),

        // Business time zone offset, used for submission numbers and date filters (Cambodia = +07:00)
        APP_UTC_OFFSET: z
            .string()
            .regex(/^[+-]\d{2}:\d{2}$/, "APP_UTC_OFFSET must look like +07:00")
            .default("+07:00"),

        SWAGGER_ENABLED: bool(undefined)
    })
    .superRefine((env, ctx) => {
        if (env.NODE_ENV === "production") {
            if (env.JWT_SECRET.length < 32) {
                ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "must be at least 32 characters in production" });
            }
            if (env.CORS_ORIGIN.split(",").some((origin) => origin.trim() === "*")) {
                ctx.addIssue({ code: "custom", path: ["CORS_ORIGIN"], message: "wildcard origin is not allowed in production" });
            }
        }
        if (env.MONGODB_MIN_POOL_SIZE > env.MONGODB_MAX_POOL_SIZE) {
            ctx.addIssue({ code: "custom", path: ["MONGODB_MIN_POOL_SIZE"], message: "must not exceed MONGODB_MAX_POOL_SIZE" });
        }
    });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    // Only variable names and rule messages are printed, never values
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join("\n")}`);
}

const env = parsed.data;

const parseTrustProxy = (value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return /^\d+$/.test(value) ? Number(value) : value;
};

const config = Object.freeze({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
    port: env.PORT,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    utcOffset: env.APP_UTC_OFFSET,

    mongodbUri: env.MONGODB_URI,
    mongodbMaxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    mongodbMinPoolSize: env.MONGODB_MIN_POOL_SIZE,

    corsOrigin: env.CORS_ORIGIN.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),

    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,

    seedAdmin: {
        name: env.ADMIN_NAME,
        email: env.ADMIN_EMAIL,
        password: env.ADMIN_PASSWORD
    },

    minio: {
        endPoint: env.MINIO_ENDPOINT,
        port: env.MINIO_PORT,
        useSSL: env.MINIO_USE_SSL,
        accessKey: env.MINIO_ACCESS_KEY,
        secretKey: env.MINIO_SECRET_KEY,
        bucket: env.MINIO_BUCKET,
        region: env.MINIO_REGION,
        urlExpirySeconds: env.FILE_URL_EXPIRY_SECONDS
    },

    upload: {
        maxFiles: env.MAX_FILES_PER_SUBMISSION,
        maxFileSizeBytes: env.MAX_FILE_SIZE_MB * 1024 * 1024,
        maxFileSizeMb: env.MAX_FILE_SIZE_MB,
        allowedMimeTypes: env.ALLOWED_FILE_TYPES.split(",")
            .map((type) => type.trim().toLowerCase())
            .filter(Boolean)
    },

    export: {
        maxImageBytes: env.EXPORT_MAX_IMAGE_MB * 1024 * 1024
    },

    rateLimit: {
        submissionWindowMs: env.PUBLIC_SUBMISSION_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
        submissionMax: env.PUBLIC_SUBMISSION_RATE_LIMIT_MAX,
        publicApiMax: env.PUBLIC_API_RATE_LIMIT_MAX,
        loginMax: env.LOGIN_RATE_LIMIT_MAX
    },

    // Swagger UI is on by default outside production
    swaggerEnabled: env.SWAGGER_ENABLED ?? env.NODE_ENV !== "production"
});

export default config;
