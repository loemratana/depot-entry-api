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
