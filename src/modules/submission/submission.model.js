import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// GeoJSON point: coordinates are [longitude, latitude]
const pointSchema = new mongoose.Schema(
    {
        type: { type: String, enum: ["Point"], required: true },
        coordinates: { type: [Number], required: true, default: undefined }
    },
    { _id: false }
);

const fileSchema = new mongoose.Schema(
    {
        originalName: { type: String, required: true },
        storedName: { type: String, required: true },
        bucket: { type: String, required: true },
        objectKey: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        uploadedAt: { type: Date, required: true },
        uploadedBy: { type: ObjectId, ref: "Admin", default: null },

        // Site photos only: device-reported GPS at capture time. Absent on
        // documents, other photos and older submissions (never an empty object)
        photoId: { type: String, default: undefined },
        location: { type: pointSchema, default: undefined },
        accuracy: { type: Number, default: undefined },
        capturedAt: { type: Date, default: undefined },
        // Small preview for the outlet map, made the first time the map needs it
        thumbnailKey: { type: String, default: undefined },
        // Small picture for Excel exports, made the first time an export needs it
        previewKey: { type: String, default: undefined }
    },
    { _id: true }
);

const submissionSchema = new mongoose.Schema(
    {
        submissionNo: { type: String, required: true },

        clientName: { type: String, required: true, trim: true },
        phone: { type: String, required: true, trim: true },

        // References plus name snapshots, so history stays readable after renames
        provinceId: { type: ObjectId, ref: "Province", required: true },
        provinceNameKh: { type: String, required: true },
        provinceNameEn: { type: String, default: "" },

        districtId: { type: ObjectId, ref: "District", required: true },
        districtNameKh: { type: String, required: true },
        districtNameEn: { type: String, default: "" },

        communeId: { type: ObjectId, ref: "Commune", required: true },
        communeNameKh: { type: String, required: true },
        communeNameEn: { type: String, default: "" },

        // Optional: the public form no longer asks for it; admins can set it later
        saleGbId: { type: ObjectId, ref: "Sale", default: null },
        saleGbName: { type: String, default: null },

        files: {
            type: [fileSchema],
            validate: [(files) => files.length > 0, "At least one file is required"]
        },

        // Client-supplied Idempotency-Key header; never returned by the API
        idempotencyKey: { type: String, default: undefined, select: false },

        // The outlet's stock report, saved in the same write as the outlet and removed once
        // the report exists. If the process stops in between, a retry or the next start
        // finishes it (see completePendingStock), so stock is never lost. Never returned.
        pendingStock: { type: mongoose.Schema.Types.Mixed, default: undefined, select: false },

        submittedAt: { type: Date, required: true, default: Date.now }
    },
    { timestamps: true }
);

// Human-readable identifier; uniqueness backs up the random generator
submissionSchema.index({ submissionNo: 1 }, { unique: true });
// Duplicate-request protection. Partial so submissions without a key are unaffected
submissionSchema.index(
    { idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);
// Default admin list order and date-range filter
submissionSchema.index({ submittedAt: -1, _id: -1 });
// Each dropdown filter combined with the default sort / date range
submissionSchema.index({ provinceId: 1, submittedAt: -1 });
submissionSchema.index({ districtId: 1, submittedAt: -1 });
submissionSchema.index({ communeId: 1, submittedAt: -1 });
submissionSchema.index({ saleGbId: 1, submittedAt: -1 });
// Phone search / lookup of repeat clients
submissionSchema.index({ phone: 1 });
// Finds the few outlets whose stock report is still pending (normally none)
submissionSchema.index(
    { _id: 1, pendingStock: 1 },
    { name: "pending_stock", partialFilterExpression: { pendingStock: { $exists: true } } }
);
// Geotagged site photos; also makes MongoDB reject malformed GeoJSON. Files without a location are not indexed
submissionSchema.index({ "files.location": "2dsphere" });

export const Submission = mongoose.model("Submission", submissionSchema);
