import crypto from "node:crypto";
import { BUCKET, putObjectFromFile, removeObjects } from "../../config/minio.js";

/**
 * Removes objects created during a failed request. Only the keys passed in are
 * touched, so unrelated existing files are never deleted. Failures are logged,
 * not thrown, so they never mask the original error.
 */
export const removeUploadedObjects = async (objectKeys) => {
    if (objectKeys.length === 0) return;
    try {
        await removeObjects(objectKeys);
    } catch (error) {
        console.error(`Failed to clean up ${objectKeys.length} uploaded object(s):`, error.message, objectKeys);
    }
};

/**
 * Uploads verified files under submissions/{submissionId}/{uuid}.{ext}.
 * If any upload fails, every object uploaded by this call is removed and the error is rethrown.
 */
export const uploadSubmissionFiles = async (submissionId, files, { uploadedBy = null } = {}) => {
    const uploads = files.map((file) => {
        const storedName = `${crypto.randomUUID()}.${file.extension}`;
        return {
            file,
            metadata: {
                originalName: file.originalname,
                storedName,
                bucket: BUCKET,
                objectKey: `submissions/${submissionId}/${storedName}`,
                mimeType: file.detectedMimeType,
                size: file.size,
                uploadedAt: null,
                uploadedBy,
                // Site photos carry their GPS fields (photoId, location, accuracy, capturedAt)
                ...file.gps
            }
        };
    });

    // Each file gets its own timestamp: the moment it was stored successfully
    const results = await Promise.allSettled(
        uploads.map(async ({ file, metadata }) => {
            await putObjectFromFile(metadata.objectKey, file.path, metadata.mimeType);
            metadata.uploadedAt = new Date();
        })
    );

    const failed = results.find((result) => result.status === "rejected");

    if (failed) {
        const succeededKeys = uploads
            .filter((_, index) => results[index].status === "fulfilled")
            .map(({ metadata }) => metadata.objectKey);

        await removeUploadedObjects(succeededKeys);

        const error = failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
        error.isStorageError = true;
        throw error;
    }

    return uploads.map(({ metadata }) => metadata);
};
