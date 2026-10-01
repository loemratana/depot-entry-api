import { BUCKET, minioClient } from "../config/minio.js";

/** Formats Excel can display; others (WebP, PDF) are listed by name */
export const EMBEDDABLE = { "image/jpeg": "jpeg", "image/png": "png" };

/** Downloads at once per export */
export const DOWNLOAD_CONCURRENCY = 6;

// Thumbnail box per cell, in pixels; rows and photo columns are sized to fit it
export const THUMB_WIDTH = 110;
export const THUMB_HEIGHT = 80;
export const PHOTO_COLUMN_WIDTH = 17; // Excel character units ≈ 124 px
export const ROW_HEIGHT_POINTS = 66; // ≈ 88 px

/** Width/height from the PNG or JPEG header, so thumbnails keep their proportions */
export const imageSize = (buffer) => {
    if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) break;
            const marker = buffer[offset + 1];
            const length = buffer.readUInt16BE(offset + 2);
            // Start-of-frame markers carry the dimensions
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
            }
            offset += 2 + length;
        }
    }
    return null;
};

export const fitThumbnail = (size) => {
    if (!size?.width || !size?.height) return { width: THUMB_WIDTH, height: THUMB_HEIGHT };
    const scale = Math.min(THUMB_WIDTH / size.width, THUMB_HEIGHT / size.height, 1);
    return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
};

export const downloadObject = async (objectKey) => {
    const stream = await minioClient.getObject(BUCKET, objectKey);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
};

/** Runs `worker` over `items` with at most `limit` in flight */
export const mapWithLimit = async (items, limit, worker) => {
    const results = new Array(items.length);
    let next = 0;
    const run = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
};

/** Places a thumbnail inside one cell (zero-based column, 1-based row number) */
export const addThumbnail = (workbook, sheet, { buffer, mimeType, col, rowNumber }) => {
    const imageId = workbook.addImage({ buffer, extension: EMBEDDABLE[mimeType] });
    const { width, height } = fitThumbnail(imageSize(buffer));
    sheet.addImage(imageId, {
        // Small offsets keep the picture inside its cell borders
        tl: { col: col + 0.05, row: rowNumber - 1 + 0.05 },
        ext: { width, height },
        editAs: "oneCell"
    });
};
