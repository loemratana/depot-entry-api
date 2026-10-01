import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import config from "../../config/env.js";
import ApiError from "../../utils/ApiError.js";
import { Admin, RefreshToken, RevokedToken } from "./auth.model.js";
import { Role } from "../rbac/role.model.js";
import { toAdminDto } from "../rbac/rbac.service.js";

export const BCRYPT_ROUNDS = 12;

// Compared against when the email is unknown so response timing does not reveal which emails exist
const DUMMY_HASH = bcrypt.hashSync("timing-safe-dummy-password", BCRYPT_ROUNDS);

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

const signToken = (admin) =>
    // Permissions are not put in the token: they are read on every request,
    // so a role change applies immediately
    jwt.sign({}, config.jwtSecret, {
        subject: admin._id.toString(),
        expiresIn: config.jwtExpiresIn,
        jwtid: crypto.randomUUID(),
        algorithm: "HS256"
    });

const DAY_MS = 24 * 60 * 60 * 1000;
// A token rotated this recently is treated as a harmless race (two tabs, a double
// request) rather than theft: the caller just gets 401, the session survives
const REUSE_GRACE_MS = 30 * 1000;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

const issueRefreshToken = async (adminId, family = crypto.randomUUID()) => {
    const refreshToken = crypto.randomBytes(48).toString("base64url");
    const expiresAt = new Date(Date.now() + config.refreshTokenExpiresDays * DAY_MS);
    await RefreshToken.create({ tokenHash: hashToken(refreshToken), adminId, family, expiresAt });
    return { refreshToken, refreshExpiresAt: expiresAt.toISOString() };
};

/** Access token + refresh token, as returned by login and refresh */
const issueSession = async (admin, family) => {
    const token = signToken(admin);
    const { exp } = jwt.decode(token);
    return {
        token,
        tokenType: "Bearer",
        expiresAt: new Date(exp * 1000).toISOString(),
        ...(await issueRefreshToken(admin._id, family)),
        admin: toAdminDto(admin, await Role.findById(admin.roleId).lean())
    };
};

export const login = async ({ email, password }) => {
    const admin = await Admin.findOne({ email }).select("+passwordHash");

    const passwordMatches = await bcrypt.compare(password, admin?.passwordHash ?? DUMMY_HASH);

    if (!admin || !passwordMatches || !admin.isActive) {
        throw ApiError.unauthorized("Invalid email or password");
    }

    admin.lastLoginAt = new Date();
    await admin.save();

    return issueSession(admin);
};

/**
 * Exchanges a refresh token for a new access token and a new refresh token.
 * The old refresh token is marked used in one atomic write, so two requests
 * with the same token can never both succeed.
 */
export const refresh = async ({ refreshToken }) => {
    const tokenHash = hashToken(refreshToken);
    const now = new Date();

    const current = await RefreshToken.findOneAndUpdate(
        { tokenHash, usedAt: null, expiresAt: { $gt: now } },
        { $set: { usedAt: now } },
        { returnDocument: "before" }
    ).lean();

    if (!current) {
        const known = await RefreshToken.findOne({ tokenHash }).lean();
        if (known?.usedAt && now - known.usedAt > REUSE_GRACE_MS) {
            // An old token came back: assume it was stolen and end that session everywhere
            await RefreshToken.deleteMany({ family: known.family });
        }
        throw ApiError.unauthorized("Session expired. Please log in again");
    }

    const admin = await Admin.findById(current.adminId);
    if (!admin || !admin.isActive) {
        await RefreshToken.deleteMany({ family: current.family });
        throw ApiError.unauthorized("Account is not active");
    }

    return issueSession(admin, current.family);
};

export const verifyToken = async (token) => {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });

    const [admin, revoked] = await Promise.all([
        Admin.findById(payload.sub),
        RevokedToken.exists({ jti: payload.jti })
    ]);

    if (revoked) throw ApiError.unauthorized("Session has been logged out");
    if (!admin || !admin.isActive) throw ApiError.unauthorized("Account is not active");

    // Read on every request so a role or permission change applies at once
    const role = admin.roleId ? await Role.findById(admin.roleId).lean() : null;
    return { admin, role, payload };
};

export const logout = async ({ admin, payload, refreshToken }) => {
    await RevokedToken.updateOne(
        { jti: payload.jti },
        { $setOnInsert: { adminId: admin._id, expiresAt: new Date(payload.exp * 1000) } },
        { upsert: true }
    );
    // Ends the whole refresh session this device holds (only if it belongs to this admin)
    if (refreshToken) {
        const known = await RefreshToken.findOne({ tokenHash: hashToken(refreshToken), adminId: admin._id })
            .select("family")
            .lean();
        if (known) await RefreshToken.deleteMany({ family: known.family });
    }
};
