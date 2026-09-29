import mongoose from "mongoose";
import multer from "multer";
import jwt from "jsonwebtoken";
import config from "../config/env.js";
import ApiError from "../utils/ApiError.js";

const DB_UNAVAILABLE_ERRORS = new Set([
    "MongoServerSelectionError",
    "MongoNetworkError",
    "MongoNetworkTimeoutError",
    "MongoNotConnectedError",
    "MongoTopologyClosedError"
]);

const NETWORK_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);

const multerMessage = (err) => {
    switch (err.code) {
        case "LIMIT_FILE_SIZE":
            return new ApiError(413, `File too large. Maximum size is ${config.upload.maxFileSizeMb} MB per file`, [
                { field: "files", message: `Each file must be ${config.upload.maxFileSizeMb} MB or smaller` }
            ]);
        case "LIMIT_FILE_COUNT":
            return ApiError.validation([
                { field: "files", message: `A maximum of ${config.upload.maxFiles} files is allowed` }
            ]);
        case "LIMIT_UNEXPECTED_FILE":
            return ApiError.validation([{ field: err.field || "files", message: 'Files must be sent in the "files" field' }]);
        default:
            return ApiError.badRequest("Invalid multipart request");
    }
};

const withRetryAfter = (apiError, seconds) => {
    apiError.retryAfterSeconds = seconds;
    return apiError;
};

const normalizeError = (err) => {
    if (err instanceof ApiError) return err;

    // Malformed JSON body from express.json()
    if (err.type === "entity.parse.failed") return ApiError.badRequest("Invalid JSON payload");
    if (err.type === "entity.too.large") return new ApiError(413, "Request payload too large");

    if (err instanceof multer.MulterError) return multerMessage(err);

    if (err instanceof jwt.TokenExpiredError) return ApiError.unauthorized("Session expired. Please log in again");
    if (err instanceof jwt.JsonWebTokenError) return ApiError.unauthorized("Invalid authentication token");

    if (err instanceof mongoose.Error.ValidationError) {
        const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
        return ApiError.validation(errors);
    }

    if (err instanceof mongoose.Error.CastError) {
        return ApiError.validation([{ field: err.path, message: `Invalid ${err.path}` }]);
    }

    if (err.code === 11000) {
        const fields = Object.keys(err.keyValue || err.keyPattern || {});
        return ApiError.conflict(
            "A record with the same value already exists",
            fields.map((field) => ({ field, message: `${field} already exists` }))
        );
    }

    if (DB_UNAVAILABLE_ERRORS.has(err.name)) return ApiError.serviceUnavailable("Database temporarily unavailable");

    // A query hit its time limit (maxTimeMS) or no connection became free in time
    if (err.code === 50 || err.codeName === "MaxTimeMSExpired") {
        return withRetryAfter(ApiError.serviceUnavailable("The request took too long. Please narrow the filters or try again"), 10);
    }
    if (/WaitQueueTimeout/.test(err.name ?? "")) {
        return withRetryAfter(ApiError.serviceUnavailable("The server is busy. Please try again in a moment"), 5);
    }

    // MinIO client errors (S3Error etc.) and connection failures to storage
    if (err.name === "S3Error" || err.isStorageError || NETWORK_ERROR_CODES.has(err.code)) {
        return ApiError.serviceUnavailable("File storage temporarily unavailable");
    }

    return ApiError.internal();
};

// Express recognises error handlers by their four arguments
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
    const apiError = normalizeError(err);

    if (apiError.statusCode >= 500) {
        console.error(`[${req.method} ${req.originalUrl}]`, err);
    }

    if (res.headersSent) {
        // Streaming response (e.g. Excel export) already started
        res.destroy(err);
        return;
    }

    const body = {
        success: false,
        message: apiError.message
    };

    if (apiError.errors) body.errors = apiError.errors;

    if (apiError.retryAfterSeconds) res.set("Retry-After", String(apiError.retryAfterSeconds));

    if (!config.isProduction && apiError.statusCode >= 500 && err.stack) {
        body.stack = err.stack;
    }

    res.status(apiError.statusCode).json(body);
};

export default errorHandler;
