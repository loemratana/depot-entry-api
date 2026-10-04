import config from "../config/env.js";

// ---------- Helpers ----------

const json = (schema, example) => ({
    "application/json": { schema, ...(example !== undefined ? { example } : {}) }
});

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const response = (name) => ({ $ref: `#/components/responses/${name}` });

const success = (dataSchema, example, extra = {}) => ({
    type: "object",
    properties: { success: { type: "boolean", example: true }, ...extra, data: dataSchema },
    example
});

const queryParam = (name, schema, description, example) => ({ name, in: "query", schema, description, example });
const idParam = (description) => ({ name: "id", in: "path", required: true, schema: ref("ObjectId"), description });

const ID = "66f7a1c2e4b0a1b2c3d4e5f6";
const PROVINCE = { id: "66f7a1c2e4b0a1b2c3d4e501", nameKh: "ភ្នំពេញ", nameEn: "Phnom Penh" };
const DISTRICT = { id: "66f7a1c2e4b0a1b2c3d4e502", nameKh: "ខណ្ឌដូនពេញ", nameEn: "Doun Penh" };
const COMMUNE = { id: "66f7a1c2e4b0a1b2c3d4e503", nameKh: "សង្កាត់ផ្សារថ្មីទី១", nameEn: "Phsar Thmei Ti Muoy" };
const SALE = { id: "66f7a1c2e4b0a1b2c3d4e504", name: "Sok Dara" };

const LIST_ITEM = {
    id: ID,
    submissionNo: "CL-20260928-7K3MQ9XA",
    clientName: "សុខា ចាន់",
    phone: "012345678",
    province: PROVINCE,
    district: DISTRICT,
    commune: COMMUNE,
    saleGb: SALE,
    fileCount: 2,
    submittedAt: "2026-09-28T03:15:42.120Z"
};

const PAGINATION = { page: 1, limit: 20, total: 125, totalPages: 7, hasNextPage: true, hasPreviousPage: false };

const filterParams = [
    queryParam("search", { type: "string", maxLength: 100 }, "Matches client name, phone digits or submission number", "sokha"),
    queryParam("provinceId", ref("ObjectId"), "Filter by province"),
    queryParam("districtId", ref("ObjectId"), "Filter by district"),
    queryParam("communeId", ref("ObjectId"), "Filter by commune"),
    queryParam("saleGbId", ref("ObjectId"), "Filter by Sale GB"),
    queryParam("dateFrom", { type: "string", format: "date" }, `Inclusive start day (YYYY-MM-DD, ${config.utcOffset})`, "2026-09-01"),
    queryParam("dateTo", { type: "string", format: "date" }, `Inclusive end day (YYYY-MM-DD, ${config.utcOffset})`, "2026-09-30"),
    queryParam("sortBy", { type: "string", enum: ["submittedAt", "clientName", "submissionNo"], default: "submittedAt" }),
    queryParam("sortOrder", { type: "string", enum: ["asc", "desc"], default: "desc" })
];

const pageParams = [
    queryParam("page", { type: "integer", minimum: 1, default: 1 }),
    queryParam("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 })
];

const location = (label) => ({
    get: {
        tags: ["Public – Locations"],
        summary: `List active ${label}`,
        responses: {
            200: {
                description: `Active ${label}, sorted by code`,
                content: json(success({ type: "array", items: ref("LocationOption") }), {
                    success: true,
                    data: [{ ...PROVINCE, code: "12" }]
                })
            },
            400: response("ValidationError")
        }
    }
});

// ---------- Spec ----------

const swaggerSpec = {
    openapi: "3.0.3",
    info: {
        title: "Client Management API",
        version: "1.0.0",
        description:
            "Backend API for the Client Data Collection & Management System.\n\n" +
            "**Public** endpoints (`/public/**`) need no authentication and are rate limited.\n\n" +
            "**Admin** endpoints (`/admin/**`) require `Authorization: Bearer <token>` from `POST /admin/auth/login`. " +
            "Use the **Authorize** button to set it."
    },
    servers: [{ url: "/api", description: "Current server" }],
    tags: [
        { name: "Health" },
        { name: "Public – Locations", description: "Province → District → Commune cascade" },
        { name: "Public – Sales" },
        { name: "Public – Submissions" },
        { name: "Admin – Auth" },
        { name: "Admin – Dashboard" },
        { name: "Admin – Users & Roles", description: "Every admin endpoint needs a permission; a missing one returns 403" },
        { name: "Admin – Submissions" },
        { name: "Admin – Sales" }
    ],
    paths: {
        "/health": {
            get: {
                tags: ["Health"],
                summary: "Health check",
                description: "Reports the real MongoDB connection state and MinIO reachability.",
                responses: {
                    200: {
                        description: "All dependencies healthy",
                        content: json(ref("HealthResponse"), {
                            success: true,
                            status: "ok",
                            environment: "development",
                            database: "connected",
                            storage: "connected",
                            timestamp: "2026-09-28T10:00:00.000Z"
                        })
                    },
                    503: {
                        description: "A dependency is unavailable",
                        content: json(ref("HealthResponse"), {
                            success: false,
                            status: "degraded",
                            environment: "development",
                            database: "connected",
                            storage: "disconnected",
                            timestamp: "2026-09-28T10:00:00.000Z"
                        })
                    }
                }
            }
        },

        "/public/locations/provinces": location("provinces"),
        "/public/locations/districts": {
            get: {
                ...location("districts").get,
                parameters: [{ ...queryParam("provinceId", ref("ObjectId"), "Parent province", PROVINCE.id), required: true }]
            }
        },
        "/public/locations/communes": {
            get: {
                ...location("communes").get,
                parameters: [{ ...queryParam("districtId", ref("ObjectId"), "Parent district", DISTRICT.id), required: true }]
            }
        },

        "/public/sales": {
            get: {
                tags: ["Public – Sales"],
                summary: "List active Sale GB entries",
                responses: {
                    200: {
                        description: "Active Sale GB entries sorted by name",
                        content: json(success({ type: "array", items: ref("SaleOption") }), {
                            success: true,
                            data: [{ id: SALE.id, name: SALE.name, code: "GB001" }]
                        })
                    }
                }
            }
        },

        "/public/submissions/photos": {
            post: {
                tags: ["Public – Submissions"],
                summary: "Upload one site photo before submitting",
                description:
                    "Lets the form upload each photo while the user is still filling it in. Returns an uploadId to list in " +
                    "`stagedPhotos` on Submit. JPG, PNG or WebP only (verified by content), up to " +
                    `${config.upload.maxFileSizeMb} MB. Photos not used within 24 hours are deleted. ` +
                    "Admins use `POST /admin/submissions/photos` (needs outlets.create).",
                requestBody: {
                    required: true,
                    content: {
                        "multipart/form-data": {
                            schema: { type: "object", required: ["photo"], properties: { photo: { type: "string", format: "binary" } } }
                        }
                    }
                },
                responses: {
                    201: {
                        description: "Stored; use the uploadId on Submit",
                        content: json(
                            success({ type: "object", properties: { uploadId: { type: "string" }, expiresAt: { type: "string", format: "date-time" } } }),
                            { success: true, message: "Photo uploaded", data: { uploadId: "q3Zb8xK2mN5pR7tV9wY1aC4eG6iL0oS3", expiresAt: "2026-10-05T08:00:00.000Z" } }
                        )
                    },
                    400: response("ValidationError"),
                    413: response("FileTooLarge"),
                    415: response("UnsupportedFileType"),
                    503: response("ServiceUnavailable")
                }
            }
        },

        "/public/submissions": {
            post: {
                tags: ["Public – Submissions"],
                summary: "Submit client information with documents",
                description:
                    `Multipart form. At least one file, at most ${config.upload.maxFiles}, each up to ${config.upload.maxFileSizeMb} MB. ` +
                    `Allowed: ${config.upload.allowedMimeTypes.join(", ")} (verified by file content).\n\n` +
                    "Locations must form a valid hierarchy and, like the Sale GB, be active. " +
                    "Names are looked up and snapshotted by the server.\n\n" +
                    "Send an `Idempotency-Key` header to make retries safe: repeating a key returns the original " +
                    "submission number with `200` and `Idempotent-Replayed: true`.\n\n" +
                    "**Site photos with GPS (optional):** send each photo as its own part named `sitePhotos[<photoId>]` " +
                    "(JPG, PNG or WebP) and one `sitePhotoMeta` JSON field listing the GPS of every photo by the same photoId. " +
                    "Photos and GPS entries are matched by photoId, never by order; each photo needs exactly one entry. " +
                    "Site photos count toward the file limit and alone satisfy the one-file minimum. " +
                    "GPS is reported by the browser and is not verified evidence.\n\n" +
                    "**Photos uploaded earlier (optional):** a photo already sent to `POST /public/submissions/photos` is attached " +
                    "by listing it in `stagedPhotos`; its GPS goes in `sitePhotoMeta` like any photo. Each uploadId works once.",
                parameters: [
                    {
                        name: "Idempotency-Key",
                        in: "header",
                        required: false,
                        schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" },
                        example: "5f0c7b0e-2d7a-4b8e-9d51-3f1f6c2e9a10"
                    }
                ],
                requestBody: {
                    required: true,
                    content: {
                        "multipart/form-data": {
                            schema: {
                                type: "object",
                                required: ["clientName", "phone", "provinceId", "files"],
                                properties: {
                                    clientName: { type: "string", minLength: 2, example: "សុខា ចាន់", description: "ឈ្មោះ ម៉ូយ" },
                                    phone: { type: "string", example: "012 345 678", description: "9–10 digits starting with 0; spaces/dashes are ignored" },
                                    provinceId: { type: "string", example: PROVINCE.id },
                                    districtId: { type: "string", example: DISTRICT.id, description: "Picked district. Send this or districtName" },
                                    districtName: {
                                        type: "string",
                                        minLength: 2,
                                        maxLength: 100,
                                        description:
                                            "District typed when it is not in the list. Matched to an existing district of the province by name (ignoring case and spacing), otherwise added"
                                    },
                                    communeId: { type: "string", example: COMMUNE.id, description: "Picked commune. Send this or communeName" },
                                    communeName: {
                                        type: "string",
                                        minLength: 2,
                                        maxLength: 100,
                                        description: "Commune typed when it is not in the list; matched or added under the district, like districtName"
                                    },
                                    saleGbId: { type: "string", example: SALE.id },
                                    files: { type: "array", items: { type: "string", format: "binary" } },
                                    sitePhotoMeta: {
                                        type: "string",
                                        description:
                                            "JSON array of { photoId, latitude (-90..90), longitude (-180..180), accuracy (metres, >= 0), capturedAt (ISO date-time) }",
                                        example: JSON.stringify([
                                            {
                                                photoId: "3f1c9a4e7b2d4c6e8a0b1c2d3e4f5a6b",
                                                latitude: 11.5564,
                                                longitude: 104.9282,
                                                accuracy: 12.5,
                                                capturedAt: "2026-09-29T05:40:00.000Z"
                                            }
                                        ])
                                    },
                                    stagedPhotos: {
                                        type: "string",
                                        description: "JSON array of { photoId, uploadId } for photos uploaded earlier",
                                        example: JSON.stringify([{ photoId: "3f1c9a4e7b2d4c6e8a0b1c2d3e4f5a6b", uploadId: "q3Zb8xK2mN5pR7tV9wY1aC4eG6iL0oS3" }])
                                    }
                                }
                            },
                            encoding: { files: { contentType: config.upload.allowedMimeTypes.join(", ") } }
                        }
                    }
                },
                responses: {
                    201: {
                        description: "Created",
                        content: json(success({ type: "object", properties: { submissionNo: { type: "string" } } }), {
                            success: true,
                            message: "Submission received successfully",
                            data: { submissionNo: "CL-20260928-7K3MQ9XA" }
                        })
                    },
                    200: { description: "Replay of an earlier request with the same Idempotency-Key (same body as 201)" },
                    400: {
                        description: "Validation failed or invalid location/Sale GB selection",
                        content: {
                            "application/json": {
                                schema: ref("ErrorResponse"),
                                examples: {
                                    fields: {
                                        summary: "Field validation",
                                        value: {
                                            success: false,
                                            message: "Validation failed",
                                            errors: [
                                                { field: "phone", message: "Invalid phone number. Use 9–10 digits starting with 0, e.g. 012345678" },
                                                { field: "files", message: "At least one file is required" }
                                            ]
                                        }
                                    },
                                    hierarchy: {
                                        summary: "Invalid hierarchy",
                                        value: {
                                            success: false,
                                            message: "Invalid location or Sale GB selection",
                                            errors: [{ field: "districtId", message: "District does not belong to the selected province" }]
                                        }
                                    }
                                }
                            }
                        }
                    },
                    413: response("FileTooLarge"),
                    415: response("UnsupportedFileType"),
                    503: response("ServiceUnavailable")
                }
            }
        },

        "/admin/map/submissions": {
            get: {
                tags: ["Admin – Map"],
                summary: "Geotagged site photos for the outlet map",
                description:
                    "One point per site photo with GPS, oldest capture first (the order of the optional capture-sequence line). " +
                    "Photos without GPS, including all older submissions, are left out. Dates filter by submission date, as on the outlet list. " +
                    "`photoUrl` (full photo) and `thumbnailUrl` (160 px preview for the marker; null until it has been made) are presigned links that stay the same for 6 hours, so browsers can cache the images. At most 2000 points are returned; when there are more, `message` says so.",
                security: [{ bearerAuth: [] }],
                parameters: [
                    ...filterParams.filter((p) => ["provinceId", "districtId", "communeId", "dateFrom", "dateTo"].includes(p.name)),
                    queryParam("submissionId", ref("ObjectId"), "Only this outlet's photos (used by View on map)")
                ],
                responses: {
                    200: {
                        description: "Map points (an empty array when nothing matches)",
                        content: json(success({ type: "array", items: { type: "object" } }), {
                            success: true,
                            data: [
                                {
                                    id: "66f7a1c2e4b0a1b2c3d4e5aa",
                                    photoId: "3f1c9a4e7b2d4c6e8a0b1c2d3e4f5a6b",
                                    submissionId: ID,
                                    clientName: "សុខា",
                                    phone: "012345678",
                                    provinceNameKh: PROVINCE.nameKh,
                                    provinceNameEn: PROVINCE.nameEn,
                                    districtNameKh: DISTRICT.nameKh,
                                    districtNameEn: DISTRICT.nameEn,
                                    communeNameKh: COMMUNE.nameKh,
                                    communeNameEn: COMMUNE.nameEn,
                                    latitude: 11.5564,
                                    longitude: 104.9282,
                                    accuracy: 12.5,
                                    capturedAt: "2026-09-29T05:40:00.000Z",
                                    submittedAt: "2026-09-29T05:41:10.000Z",
                                    photoUrl: "http://localhost:9000/client-documents/submissions/66f7.../3f1c....jpg?X-Amz-Algorithm=...",
                                    photoUrlExpiresAt: "2026-09-29T12:00:00.000Z",
                                    thumbnailUrl: "http://localhost:9000/client-documents/thumbnails/submissions/66f7.../3f1c....jpg?X-Amz-Algorithm=..."
                                }
                            ]
                        })
                    },
                    400: response("ValidationError"),
                    401: response("Unauthorized")
                }
            }
        },

        "/admin/auth/login": {
            post: {
                tags: ["Admin – Auth"],
                summary: "Log in",
                requestBody: {
                    required: true,
                    content: json(
                        {
                            type: "object",
                            required: ["email", "password"],
                            properties: { email: { type: "string", format: "email" }, password: { type: "string", format: "password" } }
                        },
                        { email: "admin@example.com", password: "your-password" }
                    )
                },
                responses: {
                    200: {
                        description: "Logged in",
                        content: json(
                            success({
                                type: "object",
                                properties: {
                                    token: { type: "string" },
                                    tokenType: { type: "string" },
                                    expiresAt: { type: "string", format: "date-time", description: "Access token expiry (JWT_EXPIRES_IN, default 14 days)" },
                                    refreshToken: { type: "string", description: "Send to /admin/auth/refresh for a new session" },
                                    refreshExpiresAt: { type: "string", format: "date-time", description: "REFRESH_TOKEN_EXPIRES_DAYS, default 30 days" },
                                    admin: ref("Admin")
                                }
                            }),
                            {
                                success: true,
                                message: "Login successful",
                                data: {
                                    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                                    tokenType: "Bearer",
                                    expiresAt: "2026-10-12T10:00:00.000Z",
                                    refreshToken: "q3Zb…(64 characters)",
                                    refreshExpiresAt: "2026-10-28T10:00:00.000Z",
                                    admin: {
                                        id: ID,
                                        name: "Administrator",
                                        email: "admin@example.com",
                                        role: { id: ID, name: "Super Admin", isSystem: true },
                                        permissions: ["outlets.view", "outlets.create", "…"],
                                        isActive: true,
                                        lastLoginAt: "2026-09-28T10:00:00.000Z",
                                        createdAt: "2026-09-01T08:00:00.000Z",
                                        updatedAt: "2026-09-28T10:00:00.000Z"
                                    }
                                }
                            }
                        )
                    },
                    400: response("ValidationError"),
                    401: {
                        description: "Wrong email or password",
                        content: json(ref("ErrorResponse"), { success: false, message: "Invalid email or password" })
                    },
                    429: response("TooManyRequests")
                }
            }
        },
        "/admin/auth/refresh": {
            post: {
                tags: ["Admin – Auth"],
                summary: "Refresh the session",
                description:
                    "Exchanges a refresh token for a new access token **and a new refresh token**; the old refresh token stops working " +
                    "(rotation). Presenting an already-used refresh token again ends that whole session. Same response as login.",
                requestBody: {
                    required: true,
                    content: json(
                        { type: "object", required: ["refreshToken"], properties: { refreshToken: { type: "string" } } },
                        { refreshToken: "q3Zb…" }
                    )
                },
                responses: {
                    200: { description: "New access and refresh tokens (same shape as login)" },
                    400: response("ValidationError"),
                    401: {
                        description: "Refresh token expired, used or revoked — log in again",
                        content: json(ref("ErrorResponse"), { success: false, message: "Session expired. Please log in again" })
                    },
                    429: response("TooManyRequests")
                }
            }
        },
        "/admin/auth/me": {
            get: {
                tags: ["Admin – Auth"],
                summary: "Current admin",
                security: [{ bearerAuth: [] }],
                responses: {
                    200: { description: "Current admin", content: json(success(ref("Admin"))) },
                    401: response("Unauthorized")
                }
            }
        },
        "/admin/auth/logout": {
            post: {
                tags: ["Admin – Auth"],
                summary: "Log out (revokes this token)",
                description: "Send the refresh token in the body to end the refresh session too (optional).",
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: false,
                    content: json({ type: "object", properties: { refreshToken: { type: "string" } } })
                },
                responses: {
                    200: { description: "Logged out", content: json(ref("MessageResponse"), { success: true, message: "Logged out successfully" }) },
                    401: response("Unauthorized")
                }
            }
        },

        "/admin/dashboard": {
            get: {
                tags: ["Admin – Dashboard"],
                summary: "Dashboard cards: outlets today / total and stock totals per product (outlets.view)",
                description:
                    "Filters by province, district, commune and period (dateFrom/dateTo, YYYY-MM-DD, Cambodia time). " +
                    "todayOutlets is always today. `products` is null without stock.view; otherwise one entry per active " +
                    "product in stock-form order with the totals of the quantities its brand counts.",
                security: [{ bearerAuth: [] }],
                parameters: [
                    queryParam("provinceId", ref("ObjectId"), "Province"),
                    queryParam("districtId", ref("ObjectId"), "District"),
                    queryParam("communeId", ref("ObjectId"), "Commune"),
                    queryParam("dateFrom", { type: "string", format: "date" }, "From (inclusive)"),
                    queryParam("dateTo", { type: "string", format: "date" }, "To (inclusive)")
                ],
                responses: {
                    200: {
                        description: "Dashboard numbers",
                        content: json(undefined, {
                            success: true,
                            data: {
                                todayOutlets: 4,
                                totalOutlets: 128,
                                products: [
                                    {
                                        productId: ID,
                                        name: "Ganzberg Gold",
                                        shortName: "GB Gold",
                                        brandName: "GANZBERG",
                                        logoUrl: null,
                                        measures: ["cases", "canRings", "cashRingsUsd", "cashRingsKhr"],
                                        totals: { cases: 540, canRings: 32, cashRingsUsd: 12, cashRingsKhr: 40 },
                                        outlets: 87
                                    }
                                ]
                            }
                        })
                    },
                    400: response("ValidationError"),
                    403: response("Forbidden")
                }
            }
        },
        "/admin/users": {
            get: {
                tags: ["Admin – Users & Roles"],
                summary: "List users (users.view)",
                security: [{ bearerAuth: [] }],
                responses: { 200: { description: "Users with their role", content: json(success({ type: "array", items: ref("Admin") })) }, 403: response("Forbidden") }
            },
            post: {
                tags: ["Admin – Users & Roles"],
                summary: "Create a user (users.manage)",
                description: "Only a Super Admin may create another Super Admin.",
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: json(
                        {
                            type: "object",
                            required: ["name", "email", "password", "roleId"],
                            properties: {
                                name: { type: "string" },
                                email: { type: "string", format: "email" },
                                password: { type: "string", minLength: 8 },
                                roleId: { type: "string" },
                                isActive: { type: "boolean" }
                            }
                        },
                        { name: "Dara", email: "dara@example.com", password: "a-long-password", roleId: ID }
                    )
                },
                responses: { 201: { description: "Created" }, 400: response("ValidationError"), 403: response("Forbidden"), 409: { description: "Email already used" } }
            }
        },
        "/admin/users/{id}": {
            patch: {
                tags: ["Admin – Users & Roles"],
                summary: "Edit a user: name, email, role, active (users.manage)",
                description:
                    "You cannot change your own role or deactivate yourself. Only a Super Admin may edit or promote Super Admins. " +
                    "The last active Super Admin cannot be demoted or deactivated (409). Deactivating ends the user's sessions.",
                security: [{ bearerAuth: [] }],
                parameters: [idParam("User id")],
                requestBody: {
                    required: true,
                    content: json({
                        type: "object",
                        properties: { name: { type: "string" }, email: { type: "string" }, roleId: { type: "string" }, isActive: { type: "boolean" } }
                    })
                },
                responses: { 200: { description: "Updated" }, 400: response("ValidationError"), 403: response("Forbidden"), 404: response("NotFound"), 409: { description: "Last Super Admin or email used" } }
            }
        },
        "/admin/users/{id}/password": {
            post: {
                tags: ["Admin – Users & Roles"],
                summary: "Reset a user's password (users.manage)",
                description: "The user's signed-in devices must log in again.",
                security: [{ bearerAuth: [] }],
                parameters: [idParam("User id")],
                requestBody: { required: true, content: json({ type: "object", required: ["password"], properties: { password: { type: "string", minLength: 8 } } }) },
                responses: { 200: { description: "Password reset" }, 403: response("Forbidden"), 404: response("NotFound") }
            }
        },
        "/admin/roles": {
            get: {
                tags: ["Admin – Users & Roles"],
                summary: "List roles with their permissions and user counts (roles.manage or users.view)",
                security: [{ bearerAuth: [] }],
                responses: { 200: { description: "Roles" }, 403: response("Forbidden") }
            },
            post: {
                tags: ["Admin – Users & Roles"],
                summary: "Create a role (roles.manage)",
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: json(
                        {
                            type: "object",
                            required: ["name", "permissions"],
                            properties: { name: { type: "string" }, description: { type: "string" }, permissions: { type: "array", items: { type: "string" } } }
                        },
                        { name: "Sale", description: "Field sales", permissions: ["outlets.view", "outlets.create"] }
                    )
                },
                responses: { 201: { description: "Created" }, 400: response("ValidationError"), 403: response("Forbidden"), 409: { description: "Name already used" } }
            }
        },
        "/admin/roles/permissions": {
            get: {
                tags: ["Admin – Users & Roles"],
                summary: "Every permission, grouped, with labels (roles.manage)",
                security: [{ bearerAuth: [] }],
                responses: { 200: { description: "Permission groups" }, 403: response("Forbidden") }
            }
        },
        "/admin/roles/{id}": {
            patch: {
                tags: ["Admin – Users & Roles"],
                summary: "Edit a role (roles.manage); the Super Admin role cannot be changed",
                security: [{ bearerAuth: [] }],
                parameters: [idParam("Role id")],
                requestBody: {
                    required: true,
                    content: json({ type: "object", properties: { name: { type: "string" }, description: { type: "string" }, permissions: { type: "array", items: { type: "string" } } } })
                },
                responses: { 200: { description: "Updated" }, 403: response("Forbidden"), 404: response("NotFound"), 409: { description: "Name already used" } }
            },
            delete: {
                tags: ["Admin – Users & Roles"],
                summary: "Delete a role (roles.manage); only when no user has it",
                security: [{ bearerAuth: [] }],
                parameters: [idParam("Role id")],
                responses: { 200: { description: "Deleted" }, 403: response("Forbidden"), 404: response("NotFound"), 409: { description: "Role still assigned" } }
            }
        },

        "/admin/submissions": {
            get: {
                tags: ["Admin – Submissions"],
                summary: "List submissions (search, filters, pagination)",
                security: [{ bearerAuth: [] }],
                parameters: [...filterParams, ...pageParams],
                responses: {
                    200: {
                        description: "A page of submissions",
                        content: json(
                            success({ type: "array", items: ref("SubmissionListItem") }, undefined, { pagination: ref("Pagination") }),
                            { success: true, data: [LIST_ITEM], pagination: PAGINATION }
                        )
                    },
                    400: response("ValidationError"),
                    401: response("Unauthorized")
                }
            }
        },
        "/admin/submissions/export": {
            get: {
                tags: ["Admin – Submissions"],
                summary: "Export submissions to Excel",
                description: "Applies exactly the same filters as the list (no pagination). Streams an .xlsx file.",
                security: [{ bearerAuth: [] }],
                parameters: filterParams,
                responses: {
                    200: {
                        description: "Excel workbook (client-submissions-YYYY-MM-DD.xlsx)",
                        content: {
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
                                schema: { type: "string", format: "binary" }
                            }
                        }
                    },
                    400: response("ValidationError"),
                    401: response("Unauthorized")
                }
            }
        },
        "/admin/submissions/{id}": {
            get: {
                tags: ["Admin – Submissions"],
                summary: "Submission details with document links",
                description: `File URLs are presigned and expire after ${config.minio.urlExpirySeconds} seconds. Fetch the details again for fresh links.`,
                security: [{ bearerAuth: [] }],
                parameters: [idParam("Submission id")],
                responses: {
                    200: {
                        description: "Submission details",
                        content: json(success(ref("SubmissionDetails")), {
                            success: true,
                            data: {
                                ...LIST_ITEM,
                                files: [
                                    {
                                        id: "66f7a1c2e4b0a1b2c3d4e5a1",
                                        originalName: "id-card.jpg",
                                        mimeType: "image/jpeg",
                                        size: 482113,
                                        uploadedAt: "2026-09-28T03:15:41.980Z",
                                        url: "http://localhost:9000/client-documents/submissions/66f7.../3f1c....jpg?X-Amz-Algorithm=...",
                                        urlExpiresAt: "2026-09-28T03:30:42.120Z"
                                    }
                                ],
                                createdAt: "2026-09-28T03:15:42.120Z",
                                updatedAt: "2026-09-28T03:15:42.120Z"
                            }
                        })
                    },
                    400: response("ValidationError"),
                    401: response("Unauthorized"),
                    404: response("NotFound")
                }
            }
        },

        "/admin/sales": {
            get: {
                tags: ["Admin – Sales"],
                summary: "List Sale GB entries",
                security: [{ bearerAuth: [] }],
                parameters: [
                    queryParam("search", { type: "string" }, "Matches name, code or phone"),
                    queryParam("isActive", { type: "string", enum: ["true", "false"] }),
                    ...pageParams
                ],
                responses: {
                    200: {
                        description: "A page of Sale GB entries",
                        content: json(success({ type: "array", items: ref("Sale") }, undefined, { pagination: ref("Pagination") }), {
                            success: true,
                            data: [
                                {
                                    id: SALE.id,
                                    name: SALE.name,
                                    code: "GB001",
                                    phone: "012345678",
                                    isActive: true,
                                    createdAt: "2026-09-01T08:00:00.000Z",
                                    updatedAt: "2026-09-01T08:00:00.000Z"
                                }
                            ],
                            pagination: { ...PAGINATION, total: 1, totalPages: 1, hasNextPage: false }
                        })
                    },
                    401: response("Unauthorized")
                }
            },
            post: {
                tags: ["Admin – Sales"],
                summary: "Create a Sale GB entry",
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: json(ref("SaleInput"), { name: "Sok Dara", code: "GB001", phone: "012345678" })
                },
                responses: {
                    201: { description: "Created", content: json(success(ref("Sale"))) },
                    400: response("ValidationError"),
                    401: response("Unauthorized"),
                    409: response("Conflict")
                }
            }
        },
        "/admin/sales/{id}": {
            patch: {
                tags: ["Admin – Sales"],
                summary: "Update or deactivate a Sale GB entry",
                description: "Sale GB entries are never deleted. Set `isActive: false` to hide one from the public form. Send `null` to clear `code` or `phone`.",
                security: [{ bearerAuth: [] }],
                parameters: [idParam("Sale GB id")],
                requestBody: {
                    required: true,
                    content: json(ref("SaleInput"), { isActive: false })
                },
                responses: {
                    200: { description: "Updated", content: json(success(ref("Sale"))) },
                    400: response("ValidationError"),
                    401: response("Unauthorized"),
                    404: response("NotFound"),
                    409: response("Conflict")
                }
            }
        }
    },

    components: {
        securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
        },
        schemas: {
            ObjectId: { type: "string", pattern: "^[a-f\\d]{24}$", example: ID },
            HealthResponse: {
                type: "object",
                properties: {
                    success: { type: "boolean" },
                    status: { type: "string", enum: ["ok", "degraded"] },
                    environment: { type: "string" },
                    database: { type: "string", enum: ["connected", "connecting", "disconnecting", "disconnected", "unknown"] },
                    storage: { type: "string", enum: ["connected", "bucket_missing", "disconnected"] },
                    timestamp: { type: "string", format: "date-time" }
                }
            },
            LocationOption: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    nameKh: { type: "string", example: "ភ្នំពេញ" },
                    nameEn: { type: "string", example: "Phnom Penh" },
                    code: { type: "string", example: "12" }
                }
            },
            SaleOption: {
                type: "object",
                properties: { id: { type: "string" }, name: { type: "string" }, code: { type: "string", nullable: true } }
            },
            Sale: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    code: { type: "string" },
                    phone: { type: "string" },
                    isActive: { type: "boolean" },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" }
                }
            },
            SaleInput: {
                type: "object",
                properties: {
                    name: { type: "string", example: "Sok Dara" },
                    code: { type: "string", nullable: true, example: "GB001" },
                    phone: { type: "string", nullable: true, example: "012345678" },
                    isActive: { type: "boolean" }
                }
            },
            Admin: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    email: { type: "string" },
                    role: {
                        type: "object",
                        nullable: true,
                        properties: { id: { type: "string" }, name: { type: "string" }, isSystem: { type: "boolean" } }
                    },
                    permissions: {
                        type: "array",
                        items: { type: "string" },
                        description: "What this user may do, e.g. outlets.view. Returned by login and /me"
                    },
                    isActive: { type: "boolean" },
                    lastLoginAt: { type: "string", format: "date-time", nullable: true },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" }
                }
            },
            NamedRef: {
                type: "object",
                properties: { id: { type: "string" }, nameKh: { type: "string" }, nameEn: { type: "string" } }
            },
            SubmissionListItem: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    submissionNo: { type: "string", example: "CL-20260928-7K3MQ9XA" },
                    clientName: { type: "string" },
                    phone: { type: "string" },
                    province: ref("NamedRef"),
                    district: ref("NamedRef"),
                    commune: ref("NamedRef"),
                    saleGb: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
                    fileCount: { type: "integer" },
                    submittedAt: { type: "string", format: "date-time" }
                }
            },
            SubmissionDetails: {
                allOf: [
                    ref("SubmissionListItem"),
                    {
                        type: "object",
                        properties: {
                            files: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        id: { type: "string" },
                                        originalName: { type: "string" },
                                        mimeType: { type: "string" },
                                        size: { type: "integer" },
                                        uploadedAt: { type: "string", format: "date-time" },
                                        url: { type: "string", description: "Short-lived presigned URL" },
                                        urlExpiresAt: { type: "string", format: "date-time" }
                                    }
                                }
                            },
                            createdAt: { type: "string", format: "date-time" },
                            updatedAt: { type: "string", format: "date-time" }
                        }
                    }
                ]
            },
            Pagination: {
                type: "object",
                properties: {
                    page: { type: "integer" },
                    limit: { type: "integer" },
                    total: { type: "integer" },
                    totalPages: { type: "integer" },
                    hasNextPage: { type: "boolean" },
                    hasPreviousPage: { type: "boolean" }
                },
                example: PAGINATION
            },
            MessageResponse: {
                type: "object",
                properties: { success: { type: "boolean" }, message: { type: "string" } }
            },
            ErrorResponse: {
                type: "object",
                required: ["success", "message"],
                properties: {
                    success: { type: "boolean", example: false },
                    message: { type: "string" },
                    errors: {
                        type: "array",
                        items: { type: "object", properties: { field: { type: "string" }, message: { type: "string" } } }
                    }
                }
            }
        },
        responses: {
            ValidationError: {
                description: "Validation failed",
                content: json(ref("ErrorResponse"), {
                    success: false,
                    message: "Validation failed",
                    errors: [{ field: "provinceId", message: "Invalid provinceId" }]
                })
            },
            Unauthorized: {
                description: "Missing, invalid, expired or logged-out token",
                content: json(ref("ErrorResponse"), { success: false, message: "Authentication required" })
            },
            Forbidden: {
                description: "Signed in, but the user's role lacks the permission this endpoint needs",
                content: json(ref("ErrorResponse"), { success: false, message: "You do not have permission to perform this action" })
            },
            NotFound: {
                description: "Not found",
                content: json(ref("ErrorResponse"), { success: false, message: "Submission not found" })
            },
            Conflict: {
                description: "Duplicate value",
                content: json(ref("ErrorResponse"), {
                    success: false,
                    message: "A record with the same value already exists",
                    errors: [{ field: "code", message: "code already exists" }]
                })
            },
            FileTooLarge: {
                description: "A file exceeds the size limit",
                content: json(ref("ErrorResponse"), {
                    success: false,
                    message: `File too large. Maximum size is ${config.upload.maxFileSizeMb} MB per file`,
                    errors: [{ field: "files", message: `Each file must be ${config.upload.maxFileSizeMb} MB or smaller` }]
                })
            },
            UnsupportedFileType: {
                description: "File type not allowed, or content does not match the declared type",
                content: json(ref("ErrorResponse"), {
                    success: false,
                    message: "Unsupported file type",
                    errors: [{ field: "files.0", message: '"notes.docx" is not a valid image/jpeg, image/png, image/webp, application/pdf file' }]
                })
            },
            TooManyRequests: {
                description: "Rate limit exceeded",
                content: json(ref("ErrorResponse"), { success: false, message: "Too many requests. Please try again later" })
            },
            ServiceUnavailable: {
                description: "Database or file storage temporarily unavailable",
                content: json(ref("ErrorResponse"), { success: false, message: "File storage temporarily unavailable" })
            }
        }
    }
};

export default swaggerSpec;
