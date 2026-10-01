import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requirePermission } from "../../middleware/auth.middleware.js";
import {
    createRoleSchema,
    createUserSchema,
    resetPasswordSchema,
    roleIdSchema,
    updateRoleSchema,
    updateUserSchema
} from "./rbac.validation.js";
import * as rbacController from "./rbac.controller.js";

// /api/admin/roles
export const adminRoleRoutes = Router();
// The Users page needs the role list for its role picker
adminRoleRoutes.get("/", requirePermission("roles.manage", "users.view"), rbacController.listRoles);
adminRoleRoutes.get("/permissions", requirePermission("roles.manage"), rbacController.getPermissions);
adminRoleRoutes.post("/", requirePermission("roles.manage"), validate(createRoleSchema), rbacController.createRole);
adminRoleRoutes.patch("/:id", requirePermission("roles.manage"), validate(updateRoleSchema), rbacController.updateRole);
adminRoleRoutes.delete("/:id", requirePermission("roles.manage"), validate(roleIdSchema), rbacController.deleteRole);

// /api/admin/users
export const adminUserRoutes = Router();
adminUserRoutes.get("/", requirePermission("users.view", "users.manage"), rbacController.listUsers);
adminUserRoutes.post("/", requirePermission("users.manage"), validate(createUserSchema), rbacController.createUser);
adminUserRoutes.patch("/:id", requirePermission("users.manage"), validate(updateUserSchema), rbacController.updateUser);
adminUserRoutes.post(
    "/:id/password",
    requirePermission("users.manage"),
    validate(resetPasswordSchema),
    rbacController.resetPassword
);
