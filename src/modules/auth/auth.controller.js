import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import * as authService from "./auth.service.js";
import { toAdminDto } from "../rbac/rbac.service.js";

export const login = asyncHandler(async (req, res) => {
    const data = await authService.login(req.validated.body);
    sendSuccess(res, { message: "Login successful", data });
});

export const refresh = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const data = await authService.refresh(req.validated.body);
    sendSuccess(res, { message: "Session refreshed", data });
});

export const me = asyncHandler(async (req, res) => {
    // Profile plus role and permissions, which the admin UI uses to show or hide pages and buttons
    sendSuccess(res, { data: toAdminDto(req.admin, req.role) });
});

export const logout = asyncHandler(async (req, res) => {
    await authService.logout({
        admin: req.admin,
        payload: req.auth,
        refreshToken: req.validated.body?.refreshToken
    });
    sendSuccess(res, { message: "Logged out successfully" });
});
