import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import * as rbacService from "./rbac.service.js";
import * as userService from "./user.service.js";

const actorOf = (req) => ({ admin: req.admin, role: req.role });

// ---------- Roles ----------

export const getPermissions = asyncHandler(async (req, res) => {
    sendSuccess(res, { data: rbacService.getPermissionCatalog() });
});

export const listRoles = asyncHandler(async (req, res) => {
    sendSuccess(res, { data: await rbacService.listRoles() });
});

export const createRole = asyncHandler(async (req, res) => {
    const data = await rbacService.createRole(req.validated.body);
    sendSuccess(res, { statusCode: 201, message: "Role created", data });
});

export const updateRole = asyncHandler(async (req, res) => {
    const data = await rbacService.updateRole(req.validated.params.id, req.validated.body);
    sendSuccess(res, { message: "Role updated", data });
});

export const deleteRole = asyncHandler(async (req, res) => {
    await rbacService.deleteRole(req.validated.params.id);
    sendSuccess(res, { message: "Role deleted" });
});

// ---------- Users ----------

export const listUsers = asyncHandler(async (req, res) => {
    sendSuccess(res, { data: await userService.listUsers() });
});

export const createUser = asyncHandler(async (req, res) => {
    const data = await userService.createUser(req.role, req.validated.body);
    sendSuccess(res, { statusCode: 201, message: "User created", data });
});

export const updateUser = asyncHandler(async (req, res) => {
    const data = await userService.updateUser(actorOf(req), req.validated.params.id, req.validated.body);
    sendSuccess(res, { message: "User updated", data });
});

export const resetPassword = asyncHandler(async (req, res) => {
    await userService.resetPassword(actorOf(req), req.validated.params.id, req.validated.body.password);
    sendSuccess(res, { message: "Password reset. The user must sign in again" });
});
