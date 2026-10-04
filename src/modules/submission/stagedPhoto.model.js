import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

/**
 * A site photo uploaded while the form is still being filled in. The form
 * sends only its uploadId on Submit; the photo is then copied to the outlet.
 * Unused photos are removed after they expire.
 */
const stagedPhotoSchema = new mongoose.Schema(
    {
        // Random and unguessable: whoever holds it may attach the photo to one outlet
        uploadId: { type: String, required: true },
        objectKey: { type: String, required: true },
        originalName: { type: String, required: true },
        mimeType: { type: String, required: true },
        extension: { type: String, required: true },
        size: { type: Number, required: true },
        uploadedBy: { type: ObjectId, ref: "Admin", default: null },
        expiresAt: { type: Date, required: true },
        // The outlet being created with it; cleared again if that fails
        claimedBy: { type: ObjectId, default: null },
        claimedAt: { type: Date, default: null }
    },
    { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

stagedPhotoSchema.index({ uploadId: 1 }, { unique: true });
stagedPhotoSchema.index({ claimedBy: 1, expiresAt: 1 });

export const StagedPhoto = mongoose.model("StagedPhoto", stagedPhotoSchema);
