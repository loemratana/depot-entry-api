import mongoose from "mongoose";
import { locationFields, locationJsonOptions, ObjectId } from "./location.schema.js";

const districtSchema = new mongoose.Schema(
    {
        provinceId: { type: ObjectId, ref: "Province", required: true },
        ...locationFields
    },
    { timestamps: true }
);

// Deduplicate districts within a province across re-imports
districtSchema.index({ provinceId: 1, code: 1 }, { unique: true });
// Public cascade query: districts of a province, active only, in code order
districtSchema.index({ provinceId: 1, isActive: 1, code: 1 });

districtSchema.set("toJSON", locationJsonOptions);

export const District = mongoose.model("District", districtSchema);
