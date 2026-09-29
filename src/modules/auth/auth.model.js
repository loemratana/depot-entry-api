import mongoose from "mongoose";

export const ADMIN_ROLES = Object.freeze(["ADMIN"]);

const adminSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        email: { type: String, required: true, trim: true, lowercase: true },
        passwordHash: { type: String, required: true, select: false },
        role: { type: String, enum: ADMIN_ROLES, default: "ADMIN" },
        isActive: { type: Boolean, default: true },
        lastLoginAt: { type: Date, default: null }
    },
    { timestamps: true }
);

// Login looks up by email; also prevents duplicate admins
adminSchema.index({ email: 1 }, { unique: true });

adminSchema.set("toJSON", {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
    }
});

export const Admin = mongoose.model("Admin", adminSchema);

/**
 * Tokens revoked by logout. Documents expire automatically when the JWT
 * itself would have expired, so the collection stays small.
 */
const revokedTokenSchema = new mongoose.Schema(
    {
        jti: { type: String, required: true },
        adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
        expiresAt: { type: Date, required: true }
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

revokedTokenSchema.index({ jti: 1 }, { unique: true });
revokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RevokedToken = mongoose.model("RevokedToken", revokedTokenSchema);

/**
 * Refresh tokens. Only a SHA-256 hash of the token is stored. Each refresh
 * marks the token used and issues a new one in the same family (rotation);
 * presenting a used token again revokes the whole family (theft detection).
 * Documents are removed automatically once expired.
 */
const refreshTokenSchema = new mongoose.Schema(
    {
        tokenHash: { type: String, required: true },
        adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
        // One family per login; every rotated token shares it
        family: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        usedAt: { type: Date, default: null }
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ family: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = mongoose.model("RefreshToken", refreshTokenSchema);
