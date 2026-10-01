/**
 * Roles & permissions: every admin route checks its permission, the built-in
 * roles and migration, and the Users / Roles safety rules.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
    ADMIN,
    Admin,
    Role,
    api,
    createAdmin,
    createUserWithPermissions,
    login,
    mongoose,
    start,
    stop
} from "./helpers.js";

const { ensureRbac, getSuperAdminRole } = await import("../src/modules/rbac/rbac.service.js");
const { PERMISSIONS } = await import("../src/modules/rbac/permissions.js");
const { hashPassword } = await import("../src/modules/auth/auth.service.js");

let superToken;
const ID = new mongoose.Types.ObjectId().toString();

before(async () => {
    await start();
    await createAdmin();
    superToken = await login();
});
after(stop);

// Every protected admin route and the permission it needs
const ROUTES = [
    ["GET", "/admin/submissions", "outlets.view"],
    ["GET", `/admin/submissions/${ID}`, "outlets.view"],
    ["POST", "/admin/submissions", "outlets.create"],
    ["PATCH", `/admin/submissions/${ID}`, "outlets.update"],
    ["DELETE", `/admin/submissions/${ID}`, "outlets.delete"],
    ["POST", `/admin/submissions/${ID}/files`, "outlets.files"],
    ["DELETE", `/admin/submissions/${ID}/files/${ID}`, "outlets.files"],
    ["GET", "/admin/submissions/export", "outlets.export"],
    ["GET", "/admin/map/submissions", "map.view"],
    ["GET", "/admin/stock/reports", "stock.view"],
    ["GET", `/admin/stock/reports/${ID}`, "stock.view"],
    ["DELETE", `/admin/stock/reports/${ID}`, "stock.delete"],
    ["GET", "/admin/stock/reports/export", "stock.export"],
    ["GET", "/admin/stock/brands", "catalog.view"],
    ["POST", "/admin/stock/brands", "catalog.manage"],
    ["PATCH", `/admin/stock/brands/${ID}`, "catalog.manage"],
    ["DELETE", `/admin/stock/brands/${ID}`, "catalog.manage"],
    ["POST", `/admin/stock/brands/${ID}/move`, "catalog.manage"],
    ["PUT", `/admin/stock/brands/${ID}/logo`, "catalog.manage"],
    ["DELETE", `/admin/stock/brands/${ID}/logo`, "catalog.manage"],
    ["POST", `/admin/stock/brands/${ID}/products`, "catalog.manage"],
    ["PATCH", `/admin/stock/products/${ID}`, "catalog.manage"],
    ["DELETE", `/admin/stock/products/${ID}`, "catalog.manage"],
    ["POST", `/admin/stock/products/${ID}/move`, "catalog.manage"],
    ["GET", "/admin/locations", "locations.view"],
    ["GET", "/admin/locations/summary", "locations.view"],
    ["GET", "/admin/locations/template", "locations.import"],
    ["POST", "/admin/locations/import", "locations.import"],
    ["POST", "/admin/locations/provinces", "locations.manage"],
    ["PATCH", `/admin/locations/districts/${ID}`, "locations.manage"],
    ["DELETE", `/admin/locations/communes/${ID}`, "locations.manage"],
    ["GET", "/admin/sales", "outlets.view"],
    ["POST", "/admin/sales", "sales.manage"],
    ["PATCH", `/admin/sales/${ID}`, "sales.manage"],
    ["GET", "/admin/users", "users.view"],
    ["POST", "/admin/users", "users.manage"],
    ["PATCH", `/admin/users/${ID}`, "users.manage"],
    ["POST", `/admin/users/${ID}/password`, "users.manage"],
    ["GET", "/admin/roles", "users.view"],
    ["GET", "/admin/roles/permissions", "roles.manage"],
    ["POST", "/admin/roles", "roles.manage"],
    ["PATCH", `/admin/roles/${ID}`, "roles.manage"],
    ["DELETE", `/admin/roles/${ID}`, "roles.manage"]
];

const call = (method, path, token) =>
    api(path, { method, token, ...(["POST", "PATCH", "PUT"].includes(method) ? { json: {} } : {}) });

describe("route permissions", () => {
    test("a user with no permissions gets 403 on every admin route, but can still use /me", async () => {
        const { token } = await createUserWithPermissions([]);
        for (const [method, path] of ROUTES) {
            const res = await call(method, path, token);
            assert.equal(res.status, 403, `${method} ${path} → ${res.status}`);
        }
        const me = await api("/admin/auth/me", { token });
        assert.equal(me.status, 200);
        assert.deepEqual(me.body.data.permissions, []);
    });

    test("each route opens with exactly its permission (and not with an unrelated one)", async () => {
        const tokens = new Map();
        for (const [method, path, permission] of ROUTES) {
            if (!tokens.has(permission)) tokens.set(permission, (await createUserWithPermissions([permission])).token);
            const res = await call(method, path, tokens.get(permission));
            assert.notEqual(res.status, 403, `${method} ${path} with ${permission} → 403`);
            assert.notEqual(res.status, 401, `${method} ${path} with ${permission} → 401`);
        }
        // An unrelated permission does not open a route
        const { token } = await createUserWithPermissions(["map.view"]);
        assert.equal((await call("DELETE", `/admin/submissions/${ID}`, token)).status, 403);
    });

    test("Super Admin can use every route", async () => {
        for (const [method, path] of ROUTES) {
            const res = await call(method, path, superToken);
            assert.ok(![401, 403].includes(res.status), `${method} ${path} → ${res.status}`);
        }
    });

    test("a permission change applies on the next request, without signing in again", async () => {
        const { role, token } = await createUserWithPermissions(["outlets.view"]);
        assert.equal((await api("/admin/submissions", { token })).status, 200);
        await Role.updateOne({ _id: role._id }, { $set: { permissions: ["map.view"] } });
        assert.equal((await api("/admin/submissions", { token })).status, 403);
        const me = await api("/admin/auth/me", { token });
        assert.deepEqual(me.body.data.permissions, ["map.view"]);
    });
});

describe("built-in roles and migration", () => {
    test("the four built-in roles exist; Super Admin has every permission", async () => {
        const res = await api("/admin/roles", { token: superToken });
        const names = res.body.data.map((r) => r.name);
        for (const name of ["Super Admin", "Manager", "Staff", "Viewer"]) assert.ok(names.includes(name), name);
        const superRole = res.body.data.find((r) => r.isSystem);
        assert.deepEqual([...superRole.permissions].sort(), [...PERMISSIONS].sort());
        const manager = res.body.data.find((r) => r.name === "Manager");
        assert.ok(!manager.permissions.some((p) => p.startsWith("users.") || p.startsWith("roles.")));
    });

    test("an account from before roles existed becomes Super Admin; running it again changes nothing", async () => {
        const legacy = await Admin.collection.insertOne({
            name: "Legacy",
            email: "legacy@example.com",
            passwordHash: await hashPassword("legacy-password-1"),
            role: "ADMIN",
            isActive: true
        });
        const first = await ensureRbac();
        assert.equal(first.migratedAdmins, 1);
        const migrated = await Admin.findById(legacy.insertedId).lean();
        assert.ok(migrated.roleId.equals((await getSuperAdminRole())._id));
        assert.equal(migrated.role, undefined);
        assert.equal((await ensureRbac()).migratedAdmins, 0);
        assert.equal(await Role.countDocuments({ isSystem: true }), 1);
    });

    test("edits to a built-in role survive a restart", async () => {
        const viewer = await Role.findOne({ key: "viewer" });
        await api(`/admin/roles/${viewer._id}`, { method: "PATCH", token: superToken, json: { permissions: ["map.view"] } });
        await ensureRbac();
        assert.deepEqual((await Role.findById(viewer._id).lean()).permissions, ["map.view"]);
    });
});

describe("roles API", () => {
    test("create, rename, change permissions; duplicate names and unknown permissions are rejected", async () => {
        const created = await api("/admin/roles", {
            method: "POST",
            token: superToken,
            json: { name: "Sale", description: "Field sales", permissions: ["outlets.view", "outlets.create"] }
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(created.body.data.userCount, 0);

        assert.equal((await api("/admin/roles", { method: "POST", token: superToken, json: { name: " sale ", permissions: [] } })).status, 409);
        assert.equal((await api("/admin/roles", { method: "POST", token: superToken, json: { name: "X Role", permissions: ["outlets.fly"] } })).status, 400);

        const updated = await api(`/admin/roles/${created.body.data.id}`, {
            method: "PATCH",
            token: superToken,
            json: { name: "Sale Team", permissions: ["outlets.view"] }
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.body.data.name, "Sale Team");
        assert.deepEqual(updated.body.data.permissions, ["outlets.view"]);
    });

    test("Super Admin role cannot be edited or deleted; a role in use cannot be deleted", async () => {
        const superRole = await getSuperAdminRole();
        assert.equal((await api(`/admin/roles/${superRole._id}`, { method: "PATCH", token: superToken, json: { name: "Boss" } })).status, 403);
        assert.equal((await api(`/admin/roles/${superRole._id}`, { method: "DELETE", token: superToken })).status, 403);

        const { role } = await createUserWithPermissions(["map.view"]);
        assert.equal((await api(`/admin/roles/${role._id}`, { method: "DELETE", token: superToken })).status, 409);

        const unused = await Role.create({ name: "Unused Role", permissions: [] });
        assert.equal((await api(`/admin/roles/${unused._id}`, { method: "DELETE", token: superToken })).status, 200);
        assert.equal(await Role.countDocuments({ _id: unused._id }), 0);
    });
});

describe("users API", () => {
    const staffRoleId = async () => (await Role.findOne({ key: "staff" }).lean())._id.toString();

    test("create a user who can then sign in with that role; duplicate email is rejected; no password hash returned", async () => {
        const res = await api("/admin/users", {
            method: "POST",
            token: superToken,
            json: { name: "Dara", email: "Dara@Example.com", password: "dara-password-1", roleId: await staffRoleId() }
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.data.email, "dara@example.com");
        assert.equal(res.body.data.role.name, "Staff");
        assert.equal(JSON.stringify(res.body).includes("passwordHash"), false);

        const signIn = await api("/admin/auth/login", { method: "POST", json: { email: "dara@example.com", password: "dara-password-1" } });
        assert.equal(signIn.status, 200);
        assert.ok(signIn.body.data.admin.permissions.includes("outlets.create"));
        assert.ok(!signIn.body.data.admin.permissions.includes("outlets.delete"));

        const dup = await api("/admin/users", {
            method: "POST",
            token: superToken,
            json: { name: "Dara 2", email: "dara@example.com", password: "dara-password-2", roleId: await staffRoleId() }
        });
        assert.equal(dup.status, 409);

        const list = await api("/admin/users", { token: superToken });
        assert.ok(list.body.data.some((u) => u.email === "dara@example.com" && u.role.name === "Staff"));
    });

    test("a non-Super-Admin user manager cannot create, promote or edit Super Admins", async () => {
        const { token } = await createUserWithPermissions(["users.view", "users.manage"]);
        const superRole = await getSuperAdminRole();
        const create = await api("/admin/users", {
            method: "POST",
            token,
            json: { name: "Sneaky", email: "sneaky@example.com", password: "sneaky-password", roleId: superRole._id.toString() }
        });
        assert.equal(create.status, 403);

        const staff = await api("/admin/users", {
            method: "POST",
            token,
            json: { name: "Staffer", email: "staffer@example.com", password: "staffer-password", roleId: await staffRoleId() }
        });
        assert.equal(staff.status, 201);
        const promote = await api(`/admin/users/${staff.body.data.id}`, { method: "PATCH", token, json: { roleId: superRole._id.toString() } });
        assert.equal(promote.status, 403);

        const superAdmin = await Admin.findOne({ email: ADMIN.email });
        assert.equal((await api(`/admin/users/${superAdmin._id}`, { method: "PATCH", token, json: { isActive: false } })).status, 403);
        assert.equal((await api(`/admin/users/${superAdmin._id}/password`, { method: "POST", token, json: { password: "hijack-password" } })).status, 403);
    });

    test("you cannot change your own role or deactivate yourself", async () => {
        const me = await Admin.findOne({ email: ADMIN.email });
        assert.equal((await api(`/admin/users/${me._id}`, { method: "PATCH", token: superToken, json: { isActive: false } })).status, 400);
        assert.equal((await api(`/admin/users/${me._id}`, { method: "PATCH", token: superToken, json: { roleId: await staffRoleId() } })).status, 400);
        // Renaming yourself is fine
        assert.equal((await api(`/admin/users/${me._id}`, { method: "PATCH", token: superToken, json: { name: "Test Admin" } })).status, 200);
    });

    test("the last active Super Admin cannot be demoted or deactivated, even by another Super Admin racing", async () => {
        const superRole = await getSuperAdminRole();
        // Exactly two active Super Admins: the main admin and a second one
        await Admin.updateMany({ roleId: superRole._id, email: { $ne: ADMIN.email } }, { $set: { isActive: false } });
        const second = await Admin.create({
            name: "Second Super",
            email: "second-super@example.com",
            passwordHash: await hashPassword("second-password-1"),
            roleId: superRole._id
        });
        const secondToken = (await api("/admin/auth/login", { method: "POST", json: { email: "second-super@example.com", password: "second-password-1" } })).body.data.token;
        const main = await Admin.findOne({ email: ADMIN.email });

        // Both try to demote the other at the same time: at most one succeeds
        const viewer = (await Role.findOne({ key: "viewer" }).lean())._id.toString();
        const results = await Promise.all([
            api(`/admin/users/${second._id}`, { method: "PATCH", token: superToken, json: { roleId: viewer } }),
            api(`/admin/users/${main._id}`, { method: "PATCH", token: secondToken, json: { roleId: viewer } })
        ]);
        assert.ok(results.filter((r) => r.status === 200).length <= 1, JSON.stringify(results.map((r) => r.status)));
        assert.ok((await Admin.countDocuments({ roleId: superRole._id, isActive: true })) >= 1);

        // Restore for the remaining tests: the main admin is the Super Admin
        await Admin.updateOne({ _id: main._id }, { $set: { roleId: superRole._id, isActive: true } });
        await Admin.updateOne({ _id: second._id }, { $set: { roleId: viewer } });
        superToken = await login();
    });

    test("deactivating or demoting the only active Super Admin is refused (409)", async () => {
        // Through the API the acting Super Admin is always a second one, so only a race reaches
        // this rule (covered above); here the service is called directly with that situation
        const { updateUser } = await import("../src/modules/rbac/user.service.js");
        const superRole = await getSuperAdminRole();
        const main = await Admin.findOne({ email: ADMIN.email });
        await Admin.updateMany({ roleId: superRole._id, _id: { $ne: main._id } }, { $set: { isActive: false } });
        const actor = { admin: { _id: new mongoose.Types.ObjectId() }, role: superRole };
        const viewer = (await Role.findOne({ key: "viewer" }).lean())._id.toString();

        await assert.rejects(updateUser(actor, main._id, { isActive: false }), (e) => e.statusCode === 409);
        await assert.rejects(updateUser(actor, main._id, { roleId: viewer }), (e) => e.statusCode === 409);
        const still = await Admin.findById(main._id).lean();
        assert.ok(still.isActive && still.roleId.equals(superRole._id));
    });

    test("deactivating a user ends their sessions at once; reset password requires the new one", async () => {
        const created = await api("/admin/users", {
            method: "POST",
            token: superToken,
            json: { name: "Temp", email: "temp@example.com", password: "temp-password-1", roleId: await staffRoleId() }
        });
        const session = (await api("/admin/auth/login", { method: "POST", json: { email: "temp@example.com", password: "temp-password-1" } })).body.data;

        // Reset password: old refresh token stops working, new password works
        assert.equal((await api(`/admin/users/${created.body.data.id}/password`, { method: "POST", token: superToken, json: { password: "temp-password-2" } })).status, 200);
        assert.equal((await api("/admin/auth/refresh", { method: "POST", json: { refreshToken: session.refreshToken } })).status, 401);
        assert.equal((await api("/admin/auth/login", { method: "POST", json: { email: "temp@example.com", password: "temp-password-1" } })).status, 401);
        const again = (await api("/admin/auth/login", { method: "POST", json: { email: "temp@example.com", password: "temp-password-2" } })).body.data;

        // Deactivate: access token and refresh token both stop working
        assert.equal((await api(`/admin/users/${created.body.data.id}`, { method: "PATCH", token: superToken, json: { isActive: false } })).status, 200);
        assert.equal((await api("/admin/auth/me", { token: again.token })).status, 401);
        assert.equal((await api("/admin/auth/refresh", { method: "POST", json: { refreshToken: again.refreshToken } })).status, 401);
    });
});
