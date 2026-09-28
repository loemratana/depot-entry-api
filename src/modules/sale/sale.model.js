import mongoose from "mongoose";

const saleSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        code: { type: String, trim: true, uppercase: true, default: undefined },
        phone: { type: String, trim: true, default: undefined },
        isActive: { type: Boolean, default: true }
    },
    { timestamps: true }
);

// Code is optional but must be unique when provided (also the seed upsert key)
saleSchema.index(
    { code: 1 },
    { unique: true, partialFilterExpression: { code: { $type: "string" } } }
);
// Public dropdown: active entries by name
saleSchema.index({ isActive: 1, name: 1 });

saleSchema.set("toJSON", {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
    }
});

// Collection name "sales" keeps the Sale GB naming used across the API
export const Sale = mongoose.model("Sale", saleSchema);
