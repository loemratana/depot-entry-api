import ApiError from "../../utils/ApiError.js";
import { Admin, RefreshToken } from "../auth/auth.model.js";
import { hashPassword } from "../auth/auth.service.js";
import { countActiveSuperAdmins, getSuperAdminRole, toAdminDto } from "./rbac.service.js";
import { Role } from "./role.model.js";

const isDuplicateKey = (error) => error?.code === 11000;
const duplicateEmail = () =>
    ApiError.conflict("A user with this email already exists", [{ field: "email", message: "This email is already used" }]);

/** Ends every refresh session of a user (their access token stops at its next check) */
const endSessions = (adminId) => RefreshToken.deleteMany({ adminId });

const findRoleOr400 = async (roleId) => {
    const role = await Role.findById(roleId).lean();
    if (!role) throw ApiError.validation([{ field: "roleId", message: "Role not found" }]);
    return role;
};

const findUserOr404 = async (id) => {
    const user = await Admin.findById(id);
    if (!user) throw ApiError.notFound("User not found");
    return user;
};

/** Only a Super Admin may create, edit or promote Super Admins (no privilege escalation) */
const assertCanTouchSuperAdmin = (actorRole) => {
    if (!actorRole?.isSystem) throw ApiError.forbidden("Only a Super Admin can manage Super Admin accounts");
};

export const listUsers = async () => {
    const [users, roles] = await Promise.all([Admin.find().sort({ name: 1 }).lean(), Role.find().lean()]);
    const roleOf = new Map(roles.map((role) => [role._id.toString(), role]));
    return users.map((user) => {
        const dto = toAdminDto(user, roleOf.get(String(user.roleId)) ?? null);
        delete dto.permissions; // the list shows the role; permissions live on the role
        return dto;
    });
};

export const createUser = async (actorRole, { name, email, password, roleId, isActive = true }) => {
    const role = await findRoleOr400(roleId);
    if (role.isSystem) assertCanTouchSuperAdmin(actorRole);
    try {
        const user = await Admin.create({ name, email, passwordHash: await hashPassword(password), roleId: role._id, isActive });
        return toAdminDto(user, role);
    } catch (error) {
        if (isDuplicateKey(error)) throw duplicateEmail();
        throw error;
    }
};

/**
 * Rules: you cannot deactivate yourself or change your own role (no lockout),
 * only a Super Admin may touch Super Admins, and the last active Super Admin
 * can never be demoted or deactivated (checked again after saving, so two
 * admins demoting each other at once cannot both succeed).
 */
export const updateUser = async (actor, id, changes) => {
    const user = await findUserOr404(id);
    const isSelf = user._id.equals(actor.admin._id);
    const superAdmin = await getSuperAdminRole();
    const wasSuper = user.roleId?.equals(superAdmin._id);

    const nextRole = changes.roleId ? await findRoleOr400(changes.roleId) : null;
    const roleChanges = nextRole && !nextRole._id.equals(user.roleId);
    const deactivates = changes.isActive === false && user.isActive;

    if (wasSuper || nextRole?.isSystem) assertCanTouchSuperAdmin(actor.role);
    if (isSelf && roleChanges) throw ApiError.badRequest("You cannot change your own role");
    if (isSelf && deactivates) throw ApiError.badRequest("You cannot deactivate your own account");

    const losesSuper = wasSuper && user.isActive && ((roleChanges && !nextRole.isSystem) || deactivates);
    if (losesSuper && (await countActiveSuperAdmins()) <= 1) {
        throw ApiError.conflict("This is the last active Super Admin. Make someone else Super Admin first");
    }

    const before = { roleId: user.roleId, isActive: user.isActive };
    if (changes.name !== undefined) user.name = changes.name;
    if (changes.email !== undefined) user.email = changes.email;
    if (roleChanges) user.roleId = nextRole._id;
    if (changes.isActive !== undefined) user.isActive = changes.isActive;
    try {
        await user.save();
    } catch (error) {
        if (isDuplicateKey(error)) throw duplicateEmail();
        throw error;
    }

    if (losesSuper && (await countActiveSuperAdmins()) === 0) {
        await Admin.updateOne({ _id: user._id }, { $set: before });
        throw ApiError.conflict("This is the last active Super Admin. Make someone else Super Admin first");
    }

    if (deactivates) await endSessions(user._id);
    return toAdminDto(user, nextRole ?? (await Role.findById(user.roleId).lean()));
};

export const resetPassword = async (actor, id, password) => {
    const user = await findUserOr404(id);
    const superAdmin = await getSuperAdminRole();
    if (user.roleId?.equals(superAdmin._id) && !user._id.equals(actor.admin._id)) assertCanTouchSuperAdmin(actor.role);

    user.passwordHash = await hashPassword(password);
    await user.save();
    // Signed-in devices must log in again with the new password
    await endSessions(user._id);
};
