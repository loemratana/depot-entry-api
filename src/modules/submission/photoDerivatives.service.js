import mongoose from "mongoose";
import sharp from "sharp";
import config from "../../config/env.js";
import { putObjectFromBuffer } from "../../config/minio.js";
import { THUMB_HEIGHT, THUMB_WIDTH, downloadObject } from "../../utils/excel-images.js";
import { makeThumbnail, thumbnailKeyFor } from "../map/thumbnail.service.js";
import { Submission } from "./submission.model.js";

/*
 * Small copies of each photo, made in the background so no request waits for
 * them:
 *   - a preview for Excel exports (2× the 110×80 px cell, about 10–20 KB),
 *     previews/<photo key>.jpg
 *   - a thumbnail for the outlet map (160 px), thumbnails/<photo key>.jpg
 * Both come from one download of the original. Runs a few seconds after start,
 * after new outlets, and every hour; one photo at a time, so the server stays
 * responsive. Until a photo has its preview, exports use the original photo.
 */
const PREVIEW_QUALITY = 75;
const BATCH = 50;
const STARTUP_DELAY_MS = 10_000;
const REQUEST_DELAY_MS = 2000;

/** Photos (JPG, PNG, WebP) are shown as pictures; other files are listed by name */
export const PICTURE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const isPicture = (file) => PICTURE_TYPES.includes(file.mimeType ?? "");

export const previewKeyFor = (objectKey) => `previews/${objectKey.replace(/\.[^./]+$/, "")}.jpg`;

export const makeExportPreview = (buffer) =>
    sharp(buffer, { failOn: "none" })
        .rotate()
        .resize(THUMB_WIDTH * 2, THUMB_HEIGHT * 2, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: PREVIEW_QUALITY, mozjpeg: true })
        .toBuffer();

// Photos that cannot be read are skipped until the next restart
const failed = new Set();

/** Makes whatever the photo is missing (preview and/or thumbnail) */
const prepare = async ({ submissionId, file }) => {
    const original = await downloadObject(file.objectKey);
    const $set = {};
    if (!file.previewKey) {
        const key = previewKeyFor(file.objectKey);
        await putObjectFromBuffer(key, await makeExportPreview(original), "image/jpeg");
        $set["files.$.previewKey"] = key;
    }
    if (!file.thumbnailKey) {
        const key = thumbnailKeyFor(file.objectKey);
        await putObjectFromBuffer(key, await makeThumbnail(original), "image/jpeg");
        $set["files.$.thumbnailKey"] = key;
    }
    await Submission.updateOne({ _id: submissionId, "files._id": file._id }, { $set });
};

const findMissing = () =>
    Submission.aggregate([
        { $match: { "files.mimeType": { $in: PICTURE_TYPES } } },
        { $unwind: "$files" },
        {
            $match: {
                "files.mimeType": { $in: PICTURE_TYPES },
                $or: [{ "files.previewKey": { $exists: false } }, { "files.thumbnailKey": { $exists: false } }],
                "files._id": { $nin: [...failed].map((id) => new mongoose.Types.ObjectId(id)) }
            }
        },
        { $limit: BATCH },
        {
            $project: {
                "files._id": 1,
                "files.objectKey": 1,
                "files.previewKey": 1,
                "files.thumbnailKey": 1
            }
        }
    ]);

/**
 * Makes previews and thumbnails for every photo that is missing one, in
 * batches, one photo at a time. Returns how many photos were done.
 */
export const backfillPhotoDerivatives = async () => {
    let done = 0;
    for (;;) {
        const batch = await findMissing();
        if (batch.length === 0) return done;
        for (const row of batch) {
            try {
                await prepare({ submissionId: row._id, file: row.files });
                done++;
            } catch (error) {
                failed.add(String(row.files._id));
                console.error(`Photo preview for ${row.files.objectKey} failed:`, error.message);
            }
        }
    }
};

let running = null;
let again = false;

/** Runs the backfill unless it is already running (then once more right after) */
export const runPhotoBackfill = () => {
    if (running) {
        again = true;
        return running;
    }
    running = backfillPhotoDerivatives()
        .then((done) => {
            if (done) console.log(`Prepared previews for ${done} photo(s)`);
        })
        .catch((error) => console.error("Photo preview backfill failed:", error.message))
        .finally(() => {
            running = null;
            if (again) {
                again = false;
                void runPhotoBackfill();
            }
        });
    return running;
};

let requested = null;

/** Asks for a backfill soon (e.g. after a new outlet); repeated asks are merged */
export const requestPhotoBackfill = () => {
    // Tests run the backfill themselves when they need it
    if (config.isTest || requested) return;
    requested = setTimeout(() => {
        requested = null;
        void runPhotoBackfill();
    }, REQUEST_DELAY_MS);
    requested.unref();
};

/** At start: a backfill shortly after, then every hour */
export const schedulePhotoBackfill = (intervalMs = 60 * 60 * 1000) => {
    setTimeout(() => void runPhotoBackfill(), STARTUP_DELAY_MS).unref();
    setInterval(() => void runPhotoBackfill(), intervalMs).unref();
};
