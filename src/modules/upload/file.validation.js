import fs from "node:fs/promises";
import config from "../../config/env.js";
import ApiError from "../../utils/ApiError.js";

// Signatures ("magic bytes") of the file types we accept
const SIGNATURES = [
    { mimeType: "image/jpeg", extension: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    {
        mimeType: "image/png",
        extension: "png",
        test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    },
    {
        mimeType: "image/webp",
        extension: "webp",
        test: (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP"
    },
    { mimeType: "application/pdf", extension: "pdf", test: (b) => b.toString("ascii", 0, 5) === "%PDF-" }
];

const readHeader = async (filePath) => {
    const handle = await fs.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(16);
        const { bytesRead } = await handle.read(buffer, 0, 16, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
};

/** Detects an allowed file type from the first bytes of a buffer */
export const detectBufferType = (buffer) => {
    const header = buffer.subarray(0, 16);
    if (header.length < 4) return null;
    return SIGNATURES.find((signature) => signature.test(header)) ?? null;
};

export const detectFileType = async (filePath) => detectBufferType(await readHeader(filePath));

/**
 * Verifies each uploaded file by content, not by the client-declared MIME type
 * or filename. Returns files annotated with the detected type and a safe extension.
 */
export const validateSubmissionFiles = async (files) => {
    if (!files || files.length === 0) {
        throw ApiError.validation([{ field: "files", message: "At least one file is required" }]);
    }

    const errors = [];
    const verified = [];

    for (const [index, file] of files.entries()) {
        const detected = await detectFileType(file.path);

        if (file.size === 0) {
            errors.push({ field: `files.${index}`, message: `"${file.originalname}" is empty` });
        } else if (!detected || !config.upload.allowedMimeTypes.includes(detected.mimeType)) {
            errors.push({
                field: `files.${index}`,
                message: `"${file.originalname}" is not a valid ${config.upload.allowedMimeTypes.join(", ")} file`
            });
        } else if (detected.mimeType !== file.mimetype.toLowerCase()) {
            errors.push({
                field: `files.${index}`,
                message: `"${file.originalname}" content does not match its declared type (${file.mimetype})`
            });
        } else {
            verified.push({ ...file, detectedMimeType: detected.mimeType, extension: detected.extension });
        }
    }

    if (errors.length > 0) {
        throw new ApiError(415, "Unsupported file type", errors);
    }

    return verified;
};
