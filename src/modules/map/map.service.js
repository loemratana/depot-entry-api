import mongoose from "mongoose";
import config from "../../config/env.js";
import { getCacheablePresignedUrl } from "../../config/minio.js";
import { Submission } from "../submission/submission.model.js";
import { buildSubmissionFilter, toGps } from "../submission/submission.service.js";
import { ensureThumbnails, thumbnailFailed } from "./thumbnail.service.js";

// Missing thumbnails are made while the map waits at most this long; the rest come on a later load
const THUMBNAIL_WAIT_MS = 4000;

/** Upper bound on points per request; narrower filters show the rest */
export const MAX_MAP_POINTS = 2000;

/**
 * One point per geotagged site photo, oldest capture first (the order the
 * optional capture-sequence line follows). Filtering happens in MongoDB with
 * the same filter builder as the outlet list; photos without GPS are skipped.
 */
export const listMapPoints = async (query) => {
    const filter = buildSubmissionFilter(query);
    if (query.submissionId) filter._id = new mongoose.Types.ObjectId(query.submissionId);
    filter["files.location"] = { $exists: true };

    const rows = await Submission.aggregate([
        { $match: filter },
        { $unwind: "$files" },
        { $match: { "files.location.type": "Point" } },
        { $sort: { "files.capturedAt": 1, "files._id": 1 } },
        { $limit: MAX_MAP_POINTS + 1 },
        {
            $project: {
                clientName: 1,
                phone: 1,
                provinceNameKh: 1,
                provinceNameEn: 1,
                districtNameKh: 1,
                districtNameEn: 1,
                communeNameKh: 1,
                communeNameEn: 1,
                submittedAt: 1,
                "files._id": 1,
                "files.photoId": 1,
                "files.location": 1,
                "files.accuracy": 1,
                "files.capturedAt": 1,
                "files.objectKey": 1,
                "files.originalName": 1,
                "files.thumbnailKey": 1
            }
        }
    ]).option({ maxTimeMS: config.queryTimeoutMs });

    const truncated = rows.length > MAX_MAP_POINTS;

    const located = rows.slice(0, MAX_MAP_POINTS).flatMap((row) => {
        const gps = toGps(row.files);
        return gps ? [{ row, gps }] : [];
    });

    // Photos without a thumbnail yet (new outlets, or from before thumbnails)
    const missing = located
        .filter(({ row }) => !row.files.thumbnailKey)
        .map(({ row }) => ({
            submissionId: row._id,
            fileId: row.files._id,
            objectKey: row.files.objectKey
        }));
    if (missing.length) {
        const made = await Promise.race([
            ensureThumbnails(missing),
            new Promise((resolve) => setTimeout(() => resolve(new Map()), THUMBNAIL_WAIT_MS).unref())
        ]);
        for (const { row } of located) {
            if (!row.files.thumbnailKey) row.files.thumbnailKey = made.get(String(row.files._id));
        }
    }

    // Links are signed locally (no network call), all at once rather than one by one
    const points = await Promise.all(
        located.map(async ({ row, gps }) => {
            const photo = await getCacheablePresignedUrl(row.files.objectKey, row.files.originalName);
            const thumbnail = row.files.thumbnailKey
                ? await getCacheablePresignedUrl(row.files.thumbnailKey, row.files.originalName)
                : null;
            return {
                id: row.files._id.toString(),
                photoId: gps.photoId,
                submissionId: row._id.toString(),
                clientName: row.clientName,
                phone: row.phone,
                provinceNameKh: row.provinceNameKh,
                provinceNameEn: row.provinceNameEn,
                districtNameKh: row.districtNameKh,
                districtNameEn: row.districtNameEn,
                communeNameKh: row.communeNameKh,
                communeNameEn: row.communeNameEn,
                latitude: gps.latitude,
                longitude: gps.longitude,
                accuracy: gps.accuracy,
                capturedAt: gps.capturedAt,
                submittedAt: row.submittedAt,
                // The full photo, loaded only when a popup opens
                photoUrl: photo.url,
                photoUrlExpiresAt: photo.expiresAt.toISOString(),
                // The marker card's picture; null while it is still being made
                thumbnailUrl: thumbnail?.url ?? null,
                // Still being made: the page asks again shortly
                thumbnailPending: !thumbnail && !thumbnailFailed(row.files._id)
            };
        })
    );

    return { points, truncated };
};
