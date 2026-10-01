import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ADMIN, Admin, api, createAdmin, start, stop } from "./helpers.js";

const { RefreshToken } = await import("../src/modules/auth/auth.model.js");

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
        assert.equal(res.body.data.admin.role.name, "Super Admin");
        assert.ok(res.body.data.admin.permissions.includes("users.manage"));
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

describe("refresh tokens", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const loginSession = async () => (await api("/admin/auth/login", { method: "POST", json: ADMIN })).body.data;
    const refresh = (refreshToken) => api("/admin/auth/refresh", { method: "POST", json: { refreshToken } });

    test("login returns a 14-day access token and a 30-day refresh token (stored only as a hash)", async () => {
        const session = await loginSession();
        const accessDays = (new Date(session.expiresAt) - Date.now()) / DAY;
        const refreshDays = (new Date(session.refreshExpiresAt) - Date.now()) / DAY;
        assert.ok(accessDays > 13.9 && accessDays <= 14, `access ${accessDays}`);
        assert.ok(refreshDays > 29.9 && refreshDays <= 30, `refresh ${refreshDays}`);
        assert.ok(session.refreshToken.length >= 40);
        assert.equal(await RefreshToken.countDocuments({ tokenHash: session.refreshToken }), 0);
    });

    test("refresh returns a new working access token and a new refresh token (rotation)", async () => {
        const session = await loginSession();
        const res = await refresh(session.refreshToken);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.headers.get("cache-control"), "no-store");
        const next = res.body.data;
        assert.notEqual(next.token, session.token);
        assert.notEqual(next.refreshToken, session.refreshToken);
        assert.equal(next.admin.email, ADMIN.email);
        assert.equal((await api("/admin/auth/me", { token: next.token })).status, 200);

        // The used token no longer works; the new one does
        assert.equal((await refresh(session.refreshToken)).status, 401);
        assert.equal((await refresh(next.refreshToken)).status, 200);
    });

    test("concurrent refreshes with the same token: exactly one succeeds", async () => {
        const session = await loginSession();
        const results = await Promise.all(Array.from({ length: 5 }, () => refresh(session.refreshToken)));
        assert.equal(results.filter((r) => r.status === 200).length, 1);
        assert.ok(results.every((r) => r.status === 200 || r.status === 401));
        // A race within the grace period does not end the session
        const winner = results.find((r) => r.status === 200).body.data;
        assert.equal((await refresh(winner.refreshToken)).status, 200);
    });

    test("reusing an old refresh token after the grace period ends that whole session", async () => {
        const session = await loginSession();
        const next = (await refresh(session.refreshToken)).body.data;
        // Pretend the first token was used a minute ago
        const tokenHash = crypto.createHash("sha256").update(session.refreshToken).digest("hex");
        await RefreshToken.updateOne({ tokenHash }, { $set: { usedAt: new Date(Date.now() - 60_000) } });
        assert.equal((await refresh(session.refreshToken)).status, 401);
        assert.equal((await refresh(next.refreshToken)).status, 401, "the newer token is revoked too");
    });

    test("expired, unknown and malformed refresh tokens are rejected", async () => {
        const session = await loginSession();
        await RefreshToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        assert.equal((await refresh(session.refreshToken)).status, 401);
        assert.equal((await refresh("x".repeat(64))).status, 401);
        assert.equal((await refresh("short")).status, 400);
        assert.equal((await api("/admin/auth/refresh", { method: "POST", json: {} })).status, 400);
    });

    test("a deactivated admin cannot refresh", async () => {
        const session = await loginSession();
        await Admin.updateOne({ email: ADMIN.email }, { $set: { isActive: false } });
        try {
            assert.equal((await refresh(session.refreshToken)).status, 401);
        } finally {
            await Admin.updateOne({ email: ADMIN.email }, { $set: { isActive: true } });
        }
    });

    test("logout with the refresh token ends the session; logout without a body still works", async () => {
        const session = await loginSession();
        const out = await api("/admin/auth/logout", {
            method: "POST",
            token: session.token,
            json: { refreshToken: session.refreshToken }
        });
        assert.equal(out.status, 200);
        assert.equal((await refresh(session.refreshToken)).status, 401);

        const other = await loginSession();
        assert.equal((await api("/admin/auth/logout", { method: "POST", token: other.token })).status, 200);
    });
});
