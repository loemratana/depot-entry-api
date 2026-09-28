import mongoose from "mongoose";
import { locationFields, locationJsonOptions, ObjectId } from "./location.schema.js";

const communeSchema = new mongoose.Schema(
    {
        districtId: { type: ObjectId, ref: "District", required: true },
        provinceId: { type: ObjectId, ref: "Province", required: true },
        ...locationFields
    },
    { timestamps: true }
);

// Deduplicate communes within a district across re-imports
communeSchema.index({ districtId: 1, code: 1 }, { unique: true });
// Public cascade query: communes of a district, active only, in code order
communeSchema.index({ districtId: 1, isActive: 1, code: 1 });

communeSchema.set("toJSON", locationJsonOptions);

export const Commune = mongoose.model("Commune", communeSchema);
