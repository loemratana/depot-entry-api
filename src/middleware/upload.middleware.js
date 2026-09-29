import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import config from "../config/env.js";
import ApiError from "../utils/ApiError.js";
import { PHOTO_ID_PATTERN } from "../modules/submission/submission.validation.js";
import { detectBufferType } from "../modules/upload/file.validation.js";

export const UPLOAD_TMP_DIR = path.join(os.tmpdir(), "client-management-uploads");
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

// Files are streamed to a temp directory (not memory) so many concurrent
// uploads cannot exhaust RAM. Temp names are random; the original name is never used as a path.
const storage = multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID())
});

const fileFilter = (req, file, cb) => {
    if (!config.upload.allowedMimeTypes.includes(file.mimetype?.toLowerCase())) {
        return cb(
            new ApiError(415, "Unsupported file type", [
                {
                    field: "files",
                    message: `"${file.originalname}" is not allowed. Allowed types: ${config.upload.allowedMimeTypes.join(", ")}`
                }
            ])
        );
    }
    cb(null, true);
};

const multerUpload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: config.upload.maxFileSizeBytes,
        files: config.upload.maxFiles,
        fields: 20,
        fieldSize: 64 * 1024,
        parts: config.upload.maxFiles + 20
    }
}).fields([
    { name: "files", maxCount: config.upload.maxFiles },
    { name: "files[]", maxCount: config.upload.maxFiles }
]);

const cleanupTempFiles = (files) => {
    for (const file of files) {
        fs.promises.unlink(file.path).catch(() => {});
    }
};

// Multer (busboy) decodes filenames as latin1; re-decode so Khmer names are preserved
const decodeOriginalName = (name) => {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return decoded.includes("�") ? name : decoded;
};

/**
 * Parses multipart submissions, flattens files into req.files,
 * and guarantees temp files are removed once the response ends.
 */
export const uploadSubmissionFiles = (req, res, next) => {
    multerUpload(req, res, (err) => {
        const grouped = req.files || {};
        const files = [...(grouped.files || []), ...(grouped["files[]"] || [])];

        for (const file of files) file.originalname = decodeOriginalName(file.originalname);
        req.files = files;

        res.on("close", () => cleanupTempFiles(files));

        if (err) return next(err);

        if (files.length > config.upload.maxFiles) {
            return next(
                ApiError.validation([{ field: "files", message: `A maximum of ${config.upload.maxFiles} files is allowed` }])
            );
        }

        next();
    });
};

// ---------- Public form: documents plus geotagged site photos ----------

// Each site photo is sent in its own part named sitePhotos[<photoId>], so the
// GPS entry with the same photoId is matched by name, never by position
const SITE_PHOTO_FIELD = /^sitePhotos\[([^\]]*)\]$/;
const SITE_PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const multerAny = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (file.fieldname === "files" || file.fieldname === "files[]") return fileFilter(req, file, cb);

        const photoId = SITE_PHOTO_FIELD.exec(file.fieldname)?.[1];
        if (photoId === undefined) {
            return cb(ApiError.validation([{ field: file.fieldname, message: "Unexpected file field" }]));
        }
        if (!PHOTO_ID_PATTERN.test(photoId)) {
            return cb(ApiError.validation([{ field: "sitePhotos", message: "Invalid photoId" }]));
        }
        if (!SITE_PHOTO_MIME_TYPES.has(file.mimetype?.toLowerCase())) {
            return cb(
                new ApiError(415, "Unsupported file type", [
                    { field: `sitePhotos.${photoId}`, message: "A site photo must be a JPG, PNG or WebP image" }
                ])
            );
        }
        cb(null, true);
    },
    limits: {
        fileSize: config.upload.maxFileSizeBytes,
        // Documents and site photos together stay within the per-submission limit
        files: config.upload.maxFiles,
        fields: 20,
        // sitePhotoMeta and stockItems are JSON strings
        fieldSize: 64 * 1024,
        parts: config.upload.maxFiles + 20
    }
}).any();

/**
 * Same as uploadSubmissionFiles, plus site photos: req.files holds documents
 * and other photos, req.sitePhotos holds [{ photoId, file }].
 */
export const uploadSubmissionWithSitePhotos = (req, res, next) => {
    multerAny(req, res, (err) => {
        const all = Array.isArray(req.files) ? req.files : [];
        for (const file of all) file.originalname = decodeOriginalName(file.originalname);
        res.on("close", () => cleanupTempFiles(all));

        req.files = all.filter((file) => file.fieldname === "files" || file.fieldname === "files[]");
        req.sitePhotos = all
            .filter((file) => SITE_PHOTO_FIELD.test(file.fieldname))
            .map((file) => ({ photoId: SITE_PHOTO_FIELD.exec(file.fieldname)[1], file }));

        if (err) return next(err);

        if (all.length > config.upload.maxFiles) {
            return next(
                ApiError.validation([{ field: "files", message: `A maximum of ${config.upload.maxFiles} files is allowed` }])
            );
        }
        const ids = req.sitePhotos.map((photo) => photo.photoId);
        if (new Set(ids).size !== ids.length) {
            return next(ApiError.validation([{ field: "sitePhotos", message: "Each site photo needs its own photoId" }]));
        }

        next();
    });
};

// ---------- Admin brand logo upload ----------

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
// No SVG: it can carry scripts
const LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Single image in the "logo" field, kept in memory (admin-only, small). The
 * content is checked against the file signature so only real images are stored.
 */
export const uploadBrandLogo = (req, res, next) => {
    multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 2 },
        fileFilter: (req, file, cb) => {
            const ok = LOGO_MIME_TYPES.has(file.mimetype?.toLowerCase());
            cb(ok ? null : new ApiError(415, "The logo must be a PNG, JPG or WebP image"), ok);
        }
    }).single("logo")(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
            return next(new ApiError(413, "The logo is larger than 2 MB"));
        }
        if (err) return next(err);
        if (!req.file) return next(ApiError.validation([{ field: "logo", message: "Choose an image to upload" }]));

        const detected = detectBufferType(req.file.buffer);
        if (!detected || !LOGO_MIME_TYPES.has(detected.mimeType)) {
            return next(new ApiError(415, "The logo must be a PNG, JPG or WebP image"));
        }
        req.logo = { buffer: req.file.buffer, mimeType: detected.mimeType, extension: detected.extension };
        next();
    });
};

// ---------- Admin spreadsheet upload (location import) ----------

export const SPREADSHEET_MAX_BYTES = 5 * 1024 * 1024;

const XLSX_MIME_TYPES = new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    // Some browsers/OSes send a generic type; the content is verified afterwards
    "application/octet-stream",
    "application/zip"
]);

/**
 * Single .xlsx file in the "file" field, kept in memory (admin-only, small).
 * The ZIP signature is checked here so ExcelJS never parses arbitrary content.
 */
export const uploadSpreadsheet = (req, res, next) => {
    multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: SPREADSHEET_MAX_BYTES, files: 1, fields: 5 },
        fileFilter: (req, file, cb) => {
            const isXlsx = XLSX_MIME_TYPES.has(file.mimetype) && /\.xlsx$/i.test(file.originalname);
            cb(isXlsx ? null : new ApiError(415, "Please upload an Excel .xlsx file"), isXlsx);
        }
    }).single("file")(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
            return next(new ApiError(413, "The file is larger than 5 MB"));
        }
        if (err) return next(err);
        if (!req.file) {
            return next(ApiError.validation([{ field: "file", message: "Choose an Excel .xlsx file to upload" }]));
        }
        // .xlsx files are ZIP archives
        if (req.file.buffer.subarray(0, 4).toString("binary") !== "PK\x03\x04") {
            return next(new ApiError(415, "The file is not a valid Excel .xlsx file"));
        }
        req.file.originalname = decodeOriginalName(req.file.originalname);
        next();
    });
};
