import mongoose from "mongoose";
import { nameKey } from "../../utils/names.js";

const productSchema = new mongoose.Schema(
    {
        brandId: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", required: true },
        name: { type: String, required: true, trim: true },
        nameKey: { type: String, select: false },
        sortOrder: { type: Number, default: 0 },
        isActive: { type: Boolean, default: true }
    },
    { timestamps: true }
);

productSchema.pre("validate", function setNameKey() {
    if (this.isModified("name") || !this.nameKey) this.nameKey = nameKey(this.name);
});

// One product per name within a brand; also the seed upsert key
productSchema.index({ brandId: 1, nameKey: 1 }, { unique: true });
// Form order within a brand
productSchema.index({ brandId: 1, isActive: 1, sortOrder: 1 });

export const Product = mongoose.model("Product", productSchema);
