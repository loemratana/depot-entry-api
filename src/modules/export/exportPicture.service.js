import { EMBEDDABLE, downloadObject } from "../../utils/excel-images.js";
import {
    isPicture,
    makeExportPreview,
    requestPhotoBackfill
} from "../submission/photoDerivatives.service.js";

export { isPicture };

/*
 * Pictures in Excel exports are shown at most 110×80 px. Each photo gets a
 * small preview (about 10–20 KB), made in the background after upload (see
 * photoDerivatives.service), so exports only download previews. An export never
 * makes previews itself: on a busy server that took longer than the proxy
 * allows (504).
 */

/**
 * The picture to embed for one file: its preview, or until that exists the
 * original photo (as exports did before previews). Null when it cannot be shown.
 */
export const loadExportPicture = async (submissionId, file) => {
    if (file.previewKey) {
        try {
            return { buffer: await downloadObject(file.previewKey), mimeType: "image/jpeg" };
        } catch {
            // Removed from storage: the original is used below
        }
    }

    // Not prepared yet: the background job makes it soon
    requestPhotoBackfill();
    let original;
    try {
        original = await downloadObject(file.objectKey);
    } catch {
        return null;
    }
    if (EMBEDDABLE[file.mimeType]) return { buffer: original, mimeType: file.mimeType };

    // WebP cannot be embedded as it is; convert this one now (rare, small)
    try {
        return { buffer: await makeExportPreview(original), mimeType: "image/jpeg" };
    } catch {
        return null;
    }
};
