import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const fileSchema = new mongoose.Schema(
    {
        originalName: { type: String, required: true },
        storedName: { type: String, required: true },
        bucket: { type: String, required: true },
        objectKey: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        uploadedAt: { type: Date, required: true },
        uploadedBy: { type: ObjectId, ref: "Admin", default: null }
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

        saleGbId: { type: ObjectId, ref: "Sale", required: true },
        saleGbName: { type: String, required: true },

        files: {
            type: [fileSchema],
            validate: [(files) => files.length > 0, "At least one file is required"]
        },

        // Client-supplied Idempotency-Key header; never returned by the API
        idempotencyKey: { type: String, default: undefined, select: false },

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

export const Submission = mongoose.model("Submission", submissionSchema);
