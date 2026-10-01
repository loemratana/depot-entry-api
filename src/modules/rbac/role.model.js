import mongoose from "mongoose";
import { nameKey } from "../../utils/names.js";
import { isPermission } from "./permissions.js";

const roleSchema = new mongoose.Schema(
    {
        // Set only on the built-in roles, so they can be found after a rename
        key: { type: String, default: undefined },
        name: { type: String, required: true, trim: true, maxlength: 60 },
        // Duplicate check ignoring case and spacing
        nameKey: { type: String, required: true },
        description: { type: String, trim: true, default: "", maxlength: 300 },
        permissions: {
            type: [String],
            default: [],
            validate: [(list) => list.every(isPermission), "Unknown permission"]
        },
        // Super Admin: every permission, cannot be edited or deleted
        isSystem: { type: Boolean, default: false }
    },
    { timestamps: true }
);

roleSchema.pre("validate", function setNameKey() {
    if (this.name) this.nameKey = nameKey(this.name);
});

roleSchema.index({ nameKey: 1 }, { unique: true });
roleSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $type: "string" } } });

export const Role = mongoose.model("Role", roleSchema);
