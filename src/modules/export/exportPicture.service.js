import sharp from "sharp";
import { putObjectFromBuffer } from "../../config/minio.js";
import { EMBEDDABLE, THUMB_HEIGHT, THUMB_WIDTH, downloadObject } from "../../utils/excel-images.js";
import { Submission } from "../submission/submission.model.js";

/*
 * Pictures in Excel exports are shown at most 110×80 px, but exports used to
 * download and embed every original photo (often several MB). Now each photo
 * gets a small preview (2× the cell box, about 10–20 KB), made the first time an
 * export needs it and kept in storage (previews/<photo key>.jpg), so later
 * exports only download the preview.
 */
const PREVIEW_QUALITY = 75;

/** Photos (JPG, PNG, WebP) are shown as pictures; other files are listed by name */
export const isPicture = (file) => /^image\/(jpeg|png|webp)$/.test(file.mimeType ?? "");

export const previewKeyFor = (objectKey) => `previews/${objectKey.replace(/\.[^./]+$/, "")}.jpg`;

export const makeExportPreview = (buffer) =>
    sharp(buffer, { failOn: "none" })
        .rotate()
        .resize(THUMB_WIDTH * 2, THUMB_HEIGHT * 2, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: PREVIEW_QUALITY, mozjpeg: true })
        .toBuffer();

/**
 * The picture to embed for one file: its stored preview, else a preview made
 * now from the original (and stored for next time), else the original itself
 * when Excel can show it. Null when the file cannot be shown.
 */
export const loadExportPicture = async (submissionId, file) => {
    if (file.previewKey) {
        try {
            return { buffer: await downloadObject(file.previewKey), mimeType: "image/jpeg" };
        } catch {
            // Removed from storage: made again below
        }
    }

    let original;
    try {
        original = await downloadObject(file.objectKey);
    } catch {
        return null;
    }

    let preview;
    try {
        preview = await makeExportPreview(original);
    } catch {
        return EMBEDDABLE[file.mimeType] ? { buffer: original, mimeType: file.mimeType } : null;
    }

    // Kept for the next export; if this fails, the preview is just made again next time
    try {
        const previewKey = previewKeyFor(file.objectKey);
        await putObjectFromBuffer(previewKey, preview, "image/jpeg");
        await Submission.updateOne(
            { _id: submissionId, "files._id": file._id },
            { $set: { "files.$.previewKey": previewKey } }
        );
    } catch (error) {
        console.error(`Export preview for ${file.objectKey} not stored:`, error.message);
    }
    return { buffer: preview, mimeType: "image/jpeg" };
};
