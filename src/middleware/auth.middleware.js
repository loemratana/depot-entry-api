import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { verifyToken } from "../modules/auth/auth.service.js";

export const requireAdmin = asyncHandler(async (req, res, next) => {
    const header = req.get("authorization") || "";
    const [scheme, token] = header.split(" ");

    if (scheme?.toLowerCase() !== "bearer" || !token) {
        throw ApiError.unauthorized();
    }

    const { admin, payload } = await verifyToken(token);

    if (admin.role !== "ADMIN") {
        throw ApiError.forbidden();
    }

    req.admin = admin;
    req.auth = payload;
    next();
});
