import mongoose from "mongoose";

// Shared fields for every level of the location hierarchy
export const locationFields = {
    nameKh: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true, default: "" },
    code: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true }
};

export const locationJsonOptions = {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
    }
};

export const { ObjectId } = mongoose.Schema.Types;
