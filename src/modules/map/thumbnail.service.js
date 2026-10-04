import sharp from "sharp";
import { putObjectFromBuffer } from "../../config/minio.js";
import { downloadObject } from "../../utils/excel-images.js";
import { Submission } from "../submission/submission.model.js";

/**
 * Small square thumbnails of site photos for the outlet map. A marker card
 * shows the photo at 64×40 px; loading the full photo (often several MB for
 * older outlets) for every marker made the map slow. A 160 px thumbnail is
 * about 5–10 KB and sharp on high-density screens.
 *
 * Made once per photo, the first time the map needs it, and kept in storage
 * next to the photos (thumbnails/<photo key>.jpg).
 */
export const THUMBNAIL_SIZE = 160;
const THUMBNAIL_QUALITY = 70;
const AT_ONCE = 2;

export const thumbnailKeyFor = (objectKey) => `thumbnails/${objectKey.replace(/\.[^./]+$/, "")}.jpg`;

/** The thumbnail of one image buffer (EXIF rotation applied, centre-cropped) */
export const makeThumbnail = (buffer) =>
    sharp(buffer, { failOn: "none" })
        .rotate()
        .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: "cover" })
        .jpeg({ quality: THUMBNAIL_QUALITY, mozjpeg: true })
        .toBuffer();

// One job per photo at a time; photos that cannot be read are not retried until restart
const inFlight = new Map();
const failed = new Set();

/** True when a thumbnail could not be made (the photo cannot be read); not retried until restart */
export const thumbnailFailed = (fileId) => failed.has(String(fileId));
const queue = [];
let running = 0;

const runNext = () => {
    while (running < AT_ONCE && queue.length) {
        const job = queue.shift();
        running++;
        job().finally(() => {
            running--;
            runNext();
        });
    }
};

const createThumbnail = async ({ submissionId, fileId, objectKey }) => {
    const thumbnailKey = thumbnailKeyFor(objectKey);
    const thumbnail = await makeThumbnail(await downloadObject(objectKey));
    await putObjectFromBuffer(thumbnailKey, thumbnail, "image/jpeg");
    await Submission.updateOne(
        { _id: submissionId, "files._id": fileId },
        { $set: { "files.$.thumbnailKey": thumbnailKey } }
    );
    return thumbnailKey;
};

/**
 * Queues thumbnails for photos that have none yet. Resolves (never rejects)
 * once they are done, with fileId → thumbnailKey for the ones that worked.
 */
export const ensureThumbnails = (photos) => {
    const jobs = photos
        .filter((photo) => !failed.has(String(photo.fileId)))
        .map((photo) => {
            const id = String(photo.fileId);
            if (!inFlight.has(id)) {
                const job = new Promise((resolve) => {
                    queue.push(() =>
                        createThumbnail(photo)
                            .then(resolve, (error) => {
                                failed.add(id);
                                console.error(`Thumbnail for ${photo.objectKey} failed:`, error.message);
                                resolve(null);
                            })
                            .finally(() => inFlight.delete(id))
                    );
                });
                inFlight.set(id, job);
                runNext();
            }
            return inFlight.get(id).then((key) => [id, key]);
        });
    return Promise.all(jobs).then((done) => new Map(done.filter(([, key]) => key)));
};
