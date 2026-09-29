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
        JWT_EXPIRES_IN: z.string().default("14d"),
        REFRESH_TOKEN_EXPIRES_DAYS: int(30, { min: 1, max: 365 }),

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
        // Exports with photos built at the same time per process (each holds its photos in memory)
        EXPORT_CONCURRENCY: int(1, { min: 1, max: 10 }),
        // Exports allowed to wait for a slot, and how long they wait, before a 503 "try again"
        EXPORT_QUEUE_MAX: int(4, { min: 0, max: 100 }),
        EXPORT_QUEUE_TIMEOUT_SECONDS: int(120, { min: 1, max: 3600 }),

        // A request waiting longer than this for a free database connection fails instead of hanging
        MONGODB_WAIT_QUEUE_TIMEOUT_MS: int(10000, { min: 100 }),
        // Upper time limits for heavy reads (lists, map, exports); a slow query ends with a 503
        DB_QUERY_TIMEOUT_MS: int(15000, { min: 100 }),
        DB_EXPORT_QUERY_TIMEOUT_MS: int(120000, { min: 100 }),

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
    mongodbWaitQueueTimeoutMs: env.MONGODB_WAIT_QUEUE_TIMEOUT_MS,
    queryTimeoutMs: env.DB_QUERY_TIMEOUT_MS,
    exportQueryTimeoutMs: env.DB_EXPORT_QUERY_TIMEOUT_MS,

    corsOrigin: env.CORS_ORIGIN.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),

    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    refreshTokenExpiresDays: env.REFRESH_TOKEN_EXPIRES_DAYS,

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
        maxImageBytes: env.EXPORT_MAX_IMAGE_MB * 1024 * 1024,
        concurrency: env.EXPORT_CONCURRENCY,
        maxQueue: env.EXPORT_QUEUE_MAX,
        queueTimeoutMs: env.EXPORT_QUEUE_TIMEOUT_SECONDS * 1000
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
