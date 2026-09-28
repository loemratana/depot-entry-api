import mongoose from "mongoose";
import { locationFields, locationJsonOptions } from "./location.schema.js";

const provinceSchema = new mongoose.Schema(locationFields, { timestamps: true });

// Importer upserts by code; code is the stable identifier across re-imports
provinceSchema.index({ code: 1 }, { unique: true });
// Public dropdown: active provinces in code order
provinceSchema.index({ isActive: 1, code: 1 });

provinceSchema.set("toJSON", locationJsonOptions);

export const Province = mongoose.model("Province", provinceSchema);
