/**
 * Every permission the API checks, grouped for the Roles page. Routes refer to
 * these keys (requirePermission("outlets.delete")); roles store a subset.
 * Adding a permission here makes it available to roles; Super Admin always
 * has all of them, including ones added later.
 */
export const PERMISSION_GROUPS = Object.freeze([
    {
        key: "outlets",
        label: "Outlets",
        permissions: [
            { key: "outlets.view", label: "View outlets and their details" },
            { key: "outlets.create", label: "Add outlets" },
            { key: "outlets.update", label: "Edit outlets" },
            { key: "outlets.delete", label: "Delete outlets" },
            { key: "outlets.files", label: "Add and remove outlet files" },
            { key: "outlets.export", label: "Export outlets to Excel" }
        ]
    },
    {
        key: "map",
        label: "Outlet Map",
        permissions: [{ key: "map.view", label: "View the outlet map" }]
    },
    {
        key: "stock",
        label: "Stock",
        permissions: [
            { key: "stock.view", label: "View stock reports" },
            { key: "stock.update", label: "Add or edit an outlet's stock" },
            { key: "stock.delete", label: "Delete stock reports" },
            { key: "stock.export", label: "Export stock to Excel" }
        ]
    },
    {
        key: "catalog",
        label: "Brands & Products",
        permissions: [
            { key: "catalog.view", label: "View brands and products" },
            { key: "catalog.manage", label: "Add, edit, reorder and delete brands and products" }
        ]
    },
    {
        key: "locations",
        label: "Locations",
        permissions: [
            { key: "locations.view", label: "View locations" },
            { key: "locations.manage", label: "Add, edit, deactivate and delete locations" },
            { key: "locations.import", label: "Import locations from Excel" }
        ]
    },
    {
        key: "sales",
        label: "Sale GB",
        permissions: [{ key: "sales.manage", label: "Add and edit Sale GB names" }]
    },
    {
        key: "users",
        label: "Users",
        permissions: [
            { key: "users.view", label: "View users" },
            { key: "users.manage", label: "Add users, change their role, deactivate and reset passwords" }
        ]
    },
    {
        key: "roles",
        label: "Roles",
        permissions: [{ key: "roles.manage", label: "Create and edit roles and their permissions" }]
    }
]);

export const PERMISSIONS = Object.freeze(PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => p.key)));
const KNOWN = new Set(PERMISSIONS);
export const isPermission = (key) => KNOWN.has(key);

export const SUPER_ADMIN_KEY = "super_admin";

/**
 * Permissions added after the built-in roles were first created. Each is given
 * once to these built-in roles (when they still exist); a permission removed
 * later on the Roles page is not given back.
 */
export const PERMISSION_ADDITIONS = Object.freeze([{ permission: "stock.update", roles: ["manager", "staff"] }]);

const without = (...excluded) => PERMISSIONS.filter((key) => !excluded.some((prefix) => key.startsWith(prefix)));

/**
 * Created on first start (by key) and never overwritten afterwards, so edits
 * made on the Roles page are kept. Super Admin's permissions are not stored:
 * it always has every permission.
 */
export const DEFAULT_ROLES = Object.freeze([
    {
        key: SUPER_ADMIN_KEY,
        name: "Super Admin",
        description: "Full access, including users and roles. Cannot be edited or deleted.",
        isSystem: true,
        permissions: []
    },
    {
        key: "manager",
        name: "Manager",
        description: "Everything except managing users and roles",
        isSystem: false,
        permissions: without("users.", "roles.")
    },
    {
        key: "staff",
        name: "Staff",
        description: "Views and records outlets and stock; cannot delete, export or import",
        isSystem: false,
        permissions: [
            "outlets.view",
            "outlets.create",
            "outlets.update",
            "outlets.files",
            "map.view",
            "stock.view",
            "stock.update",
            "catalog.view",
            "locations.view"
        ]
    },
    {
        key: "viewer",
        name: "Viewer",
        description: "Read-only access",
        isSystem: false,
        permissions: ["outlets.view", "map.view", "stock.view", "catalog.view", "locations.view"]
    }
]);
