import mongoose from "mongoose";
import { MAX_QUANTITY, MEASURE_KEYS } from "./stock.constants.js";

const { ObjectId } = mongoose.Schema.Types;

const quantity = { type: Number, min: 0, max: MAX_QUANTITY, default: 0 };

// Brand and product names are snapshotted so old reports stay readable after renames
const itemSchema = new mongoose.Schema(
    {
        productId: { type: ObjectId, ref: "Product", required: true },
        brandId: { type: ObjectId, ref: "Brand", required: true },
        brandName: { type: String, required: true },
        productName: { type: String, required: true },
        // Quantities the brand counted when reported (older reports: all)
        measures: { type: [String], default: undefined },
        ...Object.fromEntries(MEASURE_KEYS.map((key) => [key, quantity]))
    },
    { _id: false }
);

const stockReportSchema = new mongoose.Schema(
    {
        // The outlet is an existing Outlet record (a client submission)
        outletId: { type: ObjectId, ref: "Submission", required: true },
        outletName: { type: String, required: true },

        provinceId: { type: ObjectId, ref: "Province", required: true },
        provinceNameKh: { type: String, required: true },
        provinceNameEn: { type: String, default: "" },
        districtId: { type: ObjectId, ref: "District", required: true },
        districtNameKh: { type: String, required: true },
        districtNameEn: { type: String, default: "" },
        communeId: { type: ObjectId, ref: "Commune", required: true },
        communeNameKh: { type: String, required: true },
        communeNameEn: { type: String, default: "" },

        items: {
            type: [itemSchema],
            validate: [(items) => items.length > 0, "At least one product is required"]
        },

        reportedAt: { type: Date, required: true, default: Date.now },
        // null when sent from the public form
        submittedBy: { type: ObjectId, ref: "Admin", default: null },
        // The admin who last changed the quantities from the Outlet page (null: never)
        updatedBy: { type: ObjectId, ref: "Admin", default: null },
        // Client-supplied Idempotency-Key header; never returned by the API
        idempotencyKey: { type: String, default: undefined, select: false }
    },
    { timestamps: true }
);

// Default list order and date-range filter
stockReportSchema.index({ reportedAt: -1, _id: -1 });
// Filters combined with the default sort
stockReportSchema.index({ outletId: 1, reportedAt: -1 });
stockReportSchema.index({ provinceId: 1, reportedAt: -1 });
stockReportSchema.index({ districtId: 1, reportedAt: -1 });
stockReportSchema.index({ communeId: 1, reportedAt: -1 });
// Duplicate-request protection; partial so reports without a key are unaffected
stockReportSchema.index(
    { idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

export const StockReport = mongoose.model("StockReport", stockReportSchema);
