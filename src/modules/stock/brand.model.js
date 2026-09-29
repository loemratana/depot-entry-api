import mongoose from "mongoose";
import { nameKey } from "../../utils/names.js";
import { MEASURE_KEYS } from "./stock.constants.js";

const brandSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        nameKh: { type: String, trim: true, default: "" },
        nameKey: { type: String, select: false },
        // Quantities counted for this brand's products, in form order; unset = all of them
        measures: { type: [{ type: String, enum: MEASURE_KEYS }], default: undefined },
        // Logo image in MinIO (private); served through GET /api/public/stock/brands/:id/logo
        logo: {
            type: new mongoose.Schema(
                { objectKey: String, mimeType: String, size: Number, updatedAt: Date },
                { _id: false }
            ),
            default: undefined
        },
        sortOrder: { type: Number, default: 0 },
        isActive: { type: Boolean, default: true }
    },
    { timestamps: true }
);

brandSchema.pre("validate", function setNameKey() {
    if (this.isModified("name") || !this.nameKey) this.nameKey = nameKey(this.name);
});

// One brand per name (ignoring case and spacing); also the seed upsert key
brandSchema.index({ nameKey: 1 }, { unique: true });
// Form order
brandSchema.index({ isActive: 1, sortOrder: 1 });

export const Brand = mongoose.model("Brand", brandSchema);
