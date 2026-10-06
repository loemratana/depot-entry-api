import ApiError from "../../utils/ApiError.js";
import { nameKey } from "../../utils/names.js";
import { Admin } from "../auth/auth.model.js";
import {
    DEFAULT_ROLES,
    PERMISSIONS,
    PERMISSION_ADDITIONS,
    PERMISSION_GROUPS,
    SUPER_ADMIN_KEY,
    isPermission
} from "./permissions.js";
import { Role } from "./role.model.js";

const isDuplicateKey = (error) => error?.code === 11000;

/** Every permission for Super Admin; otherwise the role's known permissions */
export const permissionsOf = (role) => {
    if (!role) return [];
    if (role.isSystem) return [...PERMISSIONS];
    return role.permissions.filter(isPermission);
};

export const isSuperAdminRole = (role) => !!role?.isSystem;

const roleSummary = (role) => (role ? { id: role._id.toString(), name: role.name, isSystem: !!role.isSystem } : null);

/** The signed-in user as the API returns it: profile, role and permissions */
export const toAdminDto = (admin, role) => {
    const json = typeof admin.toJSON === "function" ? admin.toJSON() : { ...admin };
    if (json._id) {
        json.id = json._id.toString();
        delete json._id;
    }
    delete json.__v;
    delete json.passwordHash;
    delete json.role;
    delete json.roleId;
    return { ...json, role: roleSummary(role), permissions: permissionsOf(role) };
};

/**
 * Creates the built-in roles if missing (never overwrites edits) and gives
 * Super Admin to accounts that have no role yet (accounts from before RBAC).
 * Safe to run at every start and concurrently.
 */
export const ensureRbac = async () => {
    for (const role of DEFAULT_ROLES) {
        try {
            await Role.updateOne(
                { key: role.key },
                { $setOnInsert: { ...role, nameKey: nameKey(role.name) } },
                { upsert: true }
            );
        } catch (error) {
            // A custom role already uses this name: keep it, skip the built-in one
            if (!isDuplicateKey(error)) throw error;
            if (role.key === SUPER_ADMIN_KEY) throw error;
        }
    }
    // Permissions added since the roles were created: given once, never again after removal
    for (const { permission, roles } of PERMISSION_ADDITIONS) {
        await Role.updateMany(
            { key: { $in: roles }, addedPermissions: { $ne: permission } },
            { $addToSet: { permissions: permission, addedPermissions: permission } }
        );
    }
    const superAdmin = await getSuperAdminRole();
    const { modifiedCount } = await Admin.updateMany(
        { $or: [{ roleId: null }, { roleId: { $exists: false } }] },
        { $set: { roleId: superAdmin._id }, $unset: { role: 1 } },
        // `role` is no longer in the schema; without this Mongoose would drop the $unset
        { strict: false }
    );
    return { migratedAdmins: modifiedCount };
};

export const getSuperAdminRole = async () => {
    const role = await Role.findOne({ key: SUPER_ADMIN_KEY }).lean();
    if (!role) throw new Error("Super Admin role is missing; run ensureRbac() first");
    return role;
};

export const countActiveSuperAdmins = async () => {
    const superAdmin = await getSuperAdminRole();
    return Admin.countDocuments({ roleId: superAdmin._id, isActive: true });
};

// ---------- Roles (admin API) ----------

export const getPermissionCatalog = () => PERMISSION_GROUPS;

const toRoleJson = (role, userCount = 0) => ({
    id: role._id.toString(),
    name: role.name,
    description: role.description ?? "",
    isSystem: !!role.isSystem,
    permissions: permissionsOf(role),
    userCount,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt
});

export const listRoles = async () => {
    const [roles, counts] = await Promise.all([
        Role.find().sort({ isSystem: -1, name: 1 }).lean(),
        Admin.aggregate([{ $group: { _id: "$roleId", count: { $sum: 1 } } }])
    ]);
    const countOf = new Map(counts.map((c) => [String(c._id), c.count]));
    return roles.map((role) => toRoleJson(role, countOf.get(role._id.toString()) ?? 0));
};

const findRoleOr404 = async (id) => {
    const role = await Role.findById(id);
    if (!role) throw ApiError.notFound("Role not found");
    return role;
};

const duplicateName = (name) =>
    ApiError.conflict(`A role named "${name}" already exists`, [{ field: "name", message: "This name is already used" }]);

export const createRole = async ({ name, description = "", permissions }) => {
    try {
        const role = await Role.create({ name, description, permissions: [...new Set(permissions)] });
        return toRoleJson(role.toObject());
    } catch (error) {
        if (isDuplicateKey(error)) throw duplicateName(name);
        throw error;
    }
};

export const updateRole = async (id, changes) => {
    const role = await findRoleOr404(id);
    if (role.isSystem) throw ApiError.forbidden("The Super Admin role cannot be changed");

    if (changes.name !== undefined) role.name = changes.name;
    if (changes.description !== undefined) role.description = changes.description;
    if (changes.permissions !== undefined) role.permissions = [...new Set(changes.permissions)];
    try {
        await role.save();
    } catch (error) {
        if (isDuplicateKey(error)) throw duplicateName(changes.name);
        throw error;
    }
    const userCount = await Admin.countDocuments({ roleId: role._id });
    return toRoleJson(role.toObject(), userCount);
};

/** Only unused, non-system roles; users must be moved to another role first */
export const deleteRole = async (id) => {
    const role = await findRoleOr404(id);
    if (role.isSystem) throw ApiError.forbidden("The Super Admin role cannot be deleted");
    const users = await Admin.countDocuments({ roleId: role._id });
    if (users > 0) {
        throw ApiError.conflict(
            `"${role.name}" is assigned to ${users} user${users === 1 ? "" : "s"}. Give them another role first`
        );
    }
    await Role.deleteOne({ _id: role._id });
    // A user given this role in the meantime would be left without access: put the role back
    if (await Admin.exists({ roleId: role._id })) {
        await Role.collection.insertOne(role.toObject());
        throw ApiError.conflict(`"${role.name}" was just assigned to a user. Give them another role first`);
    }
};
