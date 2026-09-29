import mongoose from "mongoose";
import { nameKey } from "../../utils/names.js";

const saleSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        // Normalised name (see utils/names.js); one Sale GB per name
        nameKey: { type: String, default: undefined, select: false },
        code: { type: String, trim: true, uppercase: true, default: undefined },
        phone: { type: String, trim: true, default: undefined },
        isActive: { type: Boolean, default: true }
    },
    { timestamps: true }
);

saleSchema.pre("validate", function setNameKey() {
    if (this.isModified("name") || !this.nameKey) this.nameKey = nameKey(this.name);
});

// Code is optional but must be unique when provided (also the seed upsert key)
saleSchema.index(
    { code: 1 },
    { unique: true, partialFilterExpression: { code: { $type: "string" } } }
);
// Names typed on the client form are matched by key; unique so concurrent new names cannot duplicate
saleSchema.index(
    { nameKey: 1 },
    { unique: true, partialFilterExpression: { nameKey: { $type: "string" } } }
);
// Public dropdown: active entries by name
saleSchema.index({ isActive: 1, name: 1 });

saleSchema.set("toJSON", {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.nameKey;
        return ret;
    }
});

// Collection name "sales" keeps the Sale GB naming used across the API
export const Sale = mongoose.model("Sale", saleSchema);

/**
 * Fills nameKey for Sale GB records created before it existed. Records whose
 * name duplicates another's are left without a key and reported, not merged.
 */
export const backfillSaleNameKeys = async () => {
    const missing = await Sale.find({ nameKey: { $exists: false } }).select("name");
    let skipped = 0;
    for (const sale of missing) {
        try {
            await Sale.updateOne({ _id: sale._id }, { $set: { nameKey: nameKey(sale.name) } });
        } catch (error) {
            if (error.code !== 11000) throw error;
            skipped++;
        }
    }
    if (skipped) console.warn(`Sale GB: ${skipped} record(s) share a name with another; rename them in the admin panel`);
};
