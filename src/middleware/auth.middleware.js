import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { verifyToken } from "../modules/auth/auth.service.js";
import { permissionsOf } from "../modules/rbac/rbac.service.js";

export const requireAdmin = asyncHandler(async (req, res, next) => {
    const header = req.get("authorization") || "";
    const [scheme, token] = header.split(" ");

    if (scheme?.toLowerCase() !== "bearer" || !token) {
        throw ApiError.unauthorized();
    }

    const { admin, role, payload } = await verifyToken(token);

    // Signed in but without a role: may only see /me and log out (routes check permissions)
    req.admin = admin;
    req.role = role;
    req.permissions = new Set(permissionsOf(role));
    req.auth = payload;
    next();
});

/**
 * Allows the request when the signed-in user has at least one of the given
 * permissions (see modules/rbac/permissions.js); otherwise 403.
 */
export const requirePermission = (...permissions) => (req, res, next) => {
    if (permissions.some((permission) => req.permissions?.has(permission))) return next();
    next(ApiError.forbidden());
};
