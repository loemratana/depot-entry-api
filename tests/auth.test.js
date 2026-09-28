import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, Admin, api, createAdmin, start, stop } from "./helpers.js";

before(async () => {
    await start();
    await createAdmin();
});
after(stop);

describe("admin authentication", () => {
    test("login returns a token and never the password hash", async () => {
        const res = await api("/admin/auth/login", { method: "POST", json: ADMIN });

        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
        assert.ok(res.body.data.token);
        assert.equal(res.body.data.admin.email, ADMIN.email);
        assert.equal(res.body.data.admin.role, "ADMIN");
        assert.equal(JSON.stringify(res.body).includes("passwordHash"), false);
        assert.equal(JSON.stringify(res.body).includes(ADMIN.password), false);

        const admin = await Admin.findOne({ email: ADMIN.email });
        assert.ok(admin.lastLoginAt);
    });

    test("email is case-insensitive", async () => {
        const res = await api("/admin/auth/login", { method: "POST", json: { ...ADMIN, email: ADMIN.email.toUpperCase() } });
        assert.equal(res.status, 200);
    });

    test("wrong password and unknown email give the same 401", async () => {
        const wrong = await api("/admin/auth/login", { method: "POST", json: { ...ADMIN, password: "nope-nope" } });
        const unknown = await api("/admin/auth/login", { method: "POST", json: { email: "who@example.com", password: "nope-nope" } });

        assert.equal(wrong.status, 401);
        assert.equal(unknown.status, 401);
        assert.equal(wrong.body.message, unknown.body.message);
    });

    test("invalid login payload returns field errors", async () => {
        const res = await api("/admin/auth/login", { method: "POST", json: { email: "not-an-email" } });
        assert.equal(res.status, 400);
        assert.deepEqual(res.body.errors.map((e) => e.field).sort(), ["email", "password"]);
    });

    test("inactive admins cannot log in", async () => {
        await Admin.updateOne({ email: ADMIN.email }, { isActive: false });
        const res = await api("/admin/auth/login", { method: "POST", json: ADMIN });
        await Admin.updateOne({ email: ADMIN.email }, { isActive: true });
        assert.equal(res.status, 401);
    });

    test("/me requires a valid bearer token", async () => {
        assert.equal((await api("/admin/auth/me")).status, 401);
        assert.equal((await api("/admin/auth/me", { token: "garbage" })).status, 401);

        const { body } = await api("/admin/auth/login", { method: "POST", json: ADMIN });
        const me = await api("/admin/auth/me", { token: body.data.token });
        assert.equal(me.status, 200);
        assert.equal(me.body.data.email, ADMIN.email);
        assert.equal(me.body.data.passwordHash, undefined);
    });

    test("logout revokes only that token", async () => {
        const first = (await api("/admin/auth/login", { method: "POST", json: ADMIN })).body.data.token;
        const second = (await api("/admin/auth/login", { method: "POST", json: ADMIN })).body.data.token;

        assert.equal((await api("/admin/auth/logout", { method: "POST", token: first })).status, 200);
        assert.equal((await api("/admin/auth/me", { token: first })).status, 401);
        assert.equal((await api("/admin/auth/me", { token: second })).status, 200);
    });

    test("every admin endpoint except login rejects unauthenticated requests", async () => {
        const paths = [
            ["GET", "/admin/submissions"],
            ["GET", "/admin/submissions/export"],
            ["GET", "/admin/submissions/507f1f77bcf86cd799439011"],
            ["GET", "/admin/sales"],
            ["POST", "/admin/sales"],
            ["PATCH", "/admin/sales/507f1f77bcf86cd799439011"],
            ["POST", "/admin/auth/logout"]
        ];
        for (const [method, path] of paths) {
            const res = await api(path, { method });
            assert.equal(res.status, 401, `${method} ${path}`);
        }
    });
});
