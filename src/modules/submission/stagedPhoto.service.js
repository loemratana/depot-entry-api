import crypto from "node:crypto";
import { BUCKET, copyObject, putObjectFromFile, removeObjects } from "../../config/minio.js";
import ApiError from "../../utils/ApiError.js";
import { validateSubmissionFiles } from "../upload/file.validation.js";
import { removeUploadedObjects } from "../upload/upload.service.js";
import { StagedPhoto } from "./stagedPhoto.model.js";
import { Submission } from "./submission.model.js";

/** How long an uploaded photo waits for its form to be submitted */
export const STAGED_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;
/** A claim this old whose outlet was never saved is released (the process stopped) */
const STALE_CLAIM_MS = 60 * 60 * 1000;
const CLEANUP_BATCH = 500;

const storageError = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    error.isStorageError = true;
    return error;
};

/**
 * Stores one site photo before the form is submitted. The content is checked
 * like any submitted file; only JPG, PNG and WebP images are kept.
 */
export const stagePhoto = async (file, { uploadedBy = null } = {}) => {
    let verified;
    try {
        [verified] = await validateSubmissionFiles([file]);
    } catch (error) {
        if (error instanceof ApiError && Array.isArray(error.errors)) {
            error.errors = error.errors.map((e) => ({ ...e, field: "photo" }));
        }
        throw error;
    }
    if (!verified.detectedMimeType.startsWith("image/")) {
        throw new ApiError(415, "Unsupported file type", [
            { field: "photo", message: "A site photo must be a JPG, PNG or WebP image" }
        ]);
    }

    const uploadId = crypto.randomBytes(24).toString("base64url");
    const objectKey = `staged/${crypto.randomUUID()}.${verified.extension}`;
    try {
        await putObjectFromFile(objectKey, file.path, verified.detectedMimeType);
    } catch (error) {
        throw storageError(error);
    }

    const expiresAt = new Date(Date.now() + STAGED_PHOTO_TTL_MS);
    try {
        await StagedPhoto.create({
            uploadId,
            objectKey,
            originalName: verified.originalname,
            mimeType: verified.detectedMimeType,
            extension: verified.extension,
            size: verified.size,
            uploadedBy,
            expiresAt
        });
    } catch (error) {
        await removeUploadedObjects([objectKey]);
        throw error;
    }
    return { uploadId, expiresAt };
};

const notAvailable = (entries) =>
    ApiError.validation(
        entries.map((entry) => ({
            field: `stagedPhotos.${entry.photoId}`,
            message: "This photo's upload expired or was already used. Please submit again"
        })),
        "Some photos need to be uploaded again"
    );

/**
 * Reserves the staged photos for the outlet being created, so no other
 * submission can use them. Returns them in the order given.
 */
export const claimStagedPhotos = async (entries, submissionId) => {
    if (entries.length === 0) return [];
    const docs = await StagedPhoto.find({
        uploadId: { $in: entries.map((entry) => entry.uploadId) },
        claimedBy: null,
        expiresAt: { $gt: new Date() }
    }).lean();
    const byUploadId = new Map(docs.map((doc) => [doc.uploadId, doc]));
    const missing = entries.filter((entry) => !byUploadId.has(entry.uploadId));
    if (missing.length) throw notAvailable(missing);

    const result = await StagedPhoto.updateMany(
        { _id: { $in: docs.map((doc) => doc._id) }, claimedBy: null },
        { $set: { claimedBy: submissionId, claimedAt: new Date() } }
    );
    if (result.modifiedCount !== docs.length) {
        // Another submission took one of them at the same moment
        await releaseStagedPhotos(submissionId);
        throw notAvailable(entries);
    }
    return entries.map((entry) => ({ ...entry, staged: byUploadId.get(entry.uploadId) }));
};

/** Makes the photos usable again after the outlet could not be created */
export const releaseStagedPhotos = async (submissionId) => {
    try {
        await StagedPhoto.updateMany({ claimedBy: submissionId }, { $set: { claimedBy: null, claimedAt: null } });
    } catch (error) {
        // They are released by the clean-up later
        console.error(`Staged photos of ${submissionId}: release failed:`, error.message);
    }
};

/**
 * Copies claimed photos (server side, no new upload) to the outlet's folder,
 * with the same metadata as a photo sent with the form. If one copy fails,
 * the copies made by this call are removed and the error is rethrown.
 */
export const copyStagedPhotos = async (submissionId, photos, { uploadedBy = null } = {}) => {
    const copies = photos.map(({ staged, gps }) => {
        const storedName = `${crypto.randomUUID()}.${staged.extension}`;
        return {
            from: staged.objectKey,
            metadata: {
                originalName: staged.originalName,
                storedName,
                bucket: BUCKET,
                objectKey: `submissions/${submissionId}/${storedName}`,
                mimeType: staged.mimeType,
                size: staged.size,
                uploadedAt: null,
                uploadedBy,
                ...gps
            }
        };
    });

    const results = await Promise.allSettled(
        copies.map(async ({ from, metadata }) => {
            await copyObject(from, metadata.objectKey);
            metadata.uploadedAt = new Date();
        })
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
        await removeUploadedObjects(
            copies.filter((_, index) => results[index].status === "fulfilled").map(({ metadata }) => metadata.objectKey)
        );
        throw storageError(failed.reason);
    }
    return copies.map(({ metadata }) => metadata);
};

/** After the outlet is saved: the staged copies are no longer needed */
export const finishStagedPhotos = async (submissionId) => {
    try {
        const docs = await StagedPhoto.find({ claimedBy: submissionId }).select("objectKey").lean();
        if (docs.length === 0) return;
        await removeObjects(docs.map((doc) => doc.objectKey));
        await StagedPhoto.deleteMany({ _id: { $in: docs.map((doc) => doc._id) } });
    } catch (error) {
        // The outlet is fine; the clean-up removes them later
        console.error(`Staged photos of ${submissionId}: tidy-up failed:`, error.message);
    }
};

/**
 * Removes photos nobody submitted before they expired, tidies photos whose
 * outlet was saved, and releases claims whose outlet never was. Runs at start
 * and every hour.
 */
export const cleanupStagedPhotos = async (now = new Date()) => {
    let removed = 0;

    const expired = await StagedPhoto.find({ claimedBy: null, expiresAt: { $lte: now } })
        .select("objectKey")
        .limit(CLEANUP_BATCH)
        .lean();
    if (expired.length) {
        // The records are kept if the files could not be removed, so nothing is lost track of
        await removeObjects(expired.map((doc) => doc.objectKey));
        await StagedPhoto.deleteMany({ _id: { $in: expired.map((doc) => doc._id) } });
        removed += expired.length;
    }

    const stale = await StagedPhoto.find({ claimedBy: { $ne: null }, claimedAt: { $lte: new Date(now - STALE_CLAIM_MS) } })
        .select("objectKey claimedBy")
        .limit(CLEANUP_BATCH)
        .lean();
    if (stale.length) {
        const saved = new Set(
            (
                await Submission.find({ _id: { $in: [...new Set(stale.map((doc) => String(doc.claimedBy)))] } })
                    .select("_id")
                    .lean()
            ).map((doc) => String(doc._id))
        );
        const done = stale.filter((doc) => saved.has(String(doc.claimedBy)));
        if (done.length) {
            await removeObjects(done.map((doc) => doc.objectKey));
            await StagedPhoto.deleteMany({ _id: { $in: done.map((doc) => doc._id) } });
            removed += done.length;
        }
        const abandoned = stale.filter((doc) => !saved.has(String(doc.claimedBy)));
        if (abandoned.length) {
            await StagedPhoto.updateMany(
                { _id: { $in: abandoned.map((doc) => doc._id) } },
                { $set: { claimedBy: null, claimedAt: null } }
            );
        }
    }
    return removed;
};
