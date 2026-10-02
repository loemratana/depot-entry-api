import mongoose from "mongoose";
import { nameKey } from "../../utils/names.js";

const productSchema = new mongoose.Schema(
    {
        brandId: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", required: true },
        name: { type: String, required: true, trim: true },
        // Short label for dashboard cards, e.g. "GB Gold"; the name is used when empty
        shortName: { type: String, trim: true, default: "" },
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

/**
 * Short names for the products that existed before short names were added.
 * Only fills products that have none, so names set on the admin page are kept.
 */
const DEFAULT_SHORT_NAMES = new Map(
    [
        ["Ganzberg Gold", "GB Gold"],
        ["Ganzberg Snow", "GB Snow"],
        ["ស្រាបៀរហ្គេនបឺគ Gold រោងការ", "GB Gold Wedding"],
        ["ស្រាបៀរហ្គេនបឺគ Snow រោងការ", "GB Snow Wedding"],
        ["BOOSTRONG POWER PLUS", "BSP+"],
        ["BOOSTRONG SUPER", "BSS"],
        ["IDOL", "Idol"]
    ].map(([name, shortName]) => [nameKey(name), shortName])
);

export const backfillProductShortNames = async () => {
    const products = await Product.find({ $or: [{ shortName: { $exists: false } }, { shortName: "" }] })
        .select("+nameKey name")
        .lean();
    const updates = products
        .map((product) => [product._id, DEFAULT_SHORT_NAMES.get(product.nameKey ?? nameKey(product.name))])
        .filter(([, shortName]) => shortName)
        .map(([_id, shortName]) => ({
            updateOne: { filter: { _id, $or: [{ shortName: { $exists: false } }, { shortName: "" }] }, update: { $set: { shortName } } }
        }));
    if (updates.length) await Product.bulkWrite(updates);
    return updates.length;
};
