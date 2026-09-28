import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import config from "../../config/env.js";
import ApiError from "../../utils/ApiError.js";
import { Admin, RevokedToken } from "./auth.model.js";

export const BCRYPT_ROUNDS = 12;

// Compared against when the email is unknown so response timing does not reveal which emails exist
const DUMMY_HASH = bcrypt.hashSync("timing-safe-dummy-password", BCRYPT_ROUNDS);

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

const signToken = (admin) =>
    jwt.sign({ role: admin.role }, config.jwtSecret, {
        subject: admin._id.toString(),
        expiresIn: config.jwtExpiresIn,
        jwtid: crypto.randomUUID(),
        algorithm: "HS256"
    });

export const login = async ({ email, password }) => {
    const admin = await Admin.findOne({ email }).select("+passwordHash");

    const passwordMatches = await bcrypt.compare(password, admin?.passwordHash ?? DUMMY_HASH);

    if (!admin || !passwordMatches || !admin.isActive) {
        throw ApiError.unauthorized("Invalid email or password");
    }

    admin.lastLoginAt = new Date();
    await admin.save();

    const token = signToken(admin);
    const { exp } = jwt.decode(token);

    return {
        token,
        tokenType: "Bearer",
        expiresAt: new Date(exp * 1000).toISOString(),
        admin: admin.toJSON()
    };
};

export const verifyToken = async (token) => {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });

    const [admin, revoked] = await Promise.all([
        Admin.findById(payload.sub),
        RevokedToken.exists({ jti: payload.jti })
    ]);

    if (revoked) throw ApiError.unauthorized("Session has been logged out");
    if (!admin || !admin.isActive) throw ApiError.unauthorized("Account is not active");

    return { admin, payload };
};

export const logout = async ({ admin, payload }) => {
    await RevokedToken.updateOne(
        { jti: payload.jti },
        { $setOnInsert: { adminId: admin._id, expiresAt: new Date(payload.exp * 1000) } },
        { upsert: true }
    );
};
