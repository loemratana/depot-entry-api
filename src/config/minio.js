import * as Minio from "minio";
import config from "./env.js";

const { bucket, urlExpirySeconds, ...connection } = config.minio;

// Setting the region avoids an extra network round trip when presigning URLs
export const minioClient = new Minio.Client(connection);

export const BUCKET = bucket;

const withTimeout = (promise, ms, label) =>
    Promise.race([
        promise,
        new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            timer.unref();
        })
    ]);

export const ensureBucket = async () => {
    const exists = await withTimeout(minioClient.bucketExists(BUCKET), 5000, "MinIO bucketExists");
    if (!exists) {
        await minioClient.makeBucket(BUCKET, connection.region);
        console.log(`MinIO bucket "${BUCKET}" created`);
    }
};

export const getStorageStatus = async () => {
    try {
        const exists = await withTimeout(minioClient.bucketExists(BUCKET), 2000, "MinIO health check");
        return exists ? "connected" : "bucket_missing";
    } catch {
        return "disconnected";
    }
};

export const putObjectFromFile = (objectKey, filePath, mimeType) =>
    minioClient.fPutObject(BUCKET, objectKey, filePath, { "Content-Type": mimeType });

export const putObjectFromBuffer = (objectKey, buffer, mimeType) =>
    minioClient.putObject(BUCKET, objectKey, buffer, buffer.length, { "Content-Type": mimeType });

/** Server-side copy inside the bucket (nothing is downloaded) */
export const copyObject = (fromKey, toKey) => minioClient.copyObject(BUCKET, toKey, `/${BUCKET}/${fromKey}`);

export const getObjectStream = (objectKey) => minioClient.getObject(BUCKET, objectKey);

export const removeObjects = async (objectKeys) => {
    if (objectKeys.length === 0) return;
    await minioClient.removeObjects(BUCKET, objectKeys);
};

export const getPresignedUrl = (objectKey, fileName) =>
    minioClient.presignedGetObject(BUCKET, objectKey, urlExpirySeconds, {
        // Browser shows the original name; encoded so Khmer names survive the header
        "response-content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`
    });

export const URL_EXPIRY_SECONDS = urlExpirySeconds;

/*
 * Links for images shown on the map. A normal link is new on every request, so
 * the browser downloaded every image again on each visit. These are signed for
 * a fixed 6-hour window (same link for everyone during it) and valid for 12
 * hours from its start, so the browser can keep the image while the link stays
 * the same.
 */
const CACHEABLE_WINDOW_MS = 6 * 60 * 60 * 1000;
const CACHEABLE_EXPIRY_SECONDS = 12 * 60 * 60;

export const getCacheablePresignedUrl = async (objectKey, fileName) => {
    const windowStart = new Date(Math.floor(Date.now() / CACHEABLE_WINDOW_MS) * CACHEABLE_WINDOW_MS);
    const url = await minioClient.presignedGetObject(
        BUCKET,
        objectKey,
        CACHEABLE_EXPIRY_SECONDS,
        {
            "response-content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            "response-cache-control": "private, max-age=21600"
        },
        windowStart
    );
    return { url, expiresAt: new Date(windowStart.getTime() + CACHEABLE_EXPIRY_SECONDS * 1000) };
};
