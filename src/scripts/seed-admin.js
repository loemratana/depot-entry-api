/**
 * Creates the initial admin from ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD.
 * Safe to run repeatedly: an existing admin is left untouched unless
 * --reset-password is passed.
 *
 *   npm run seed:admin
 *   npm run seed:admin -- --reset-password
 */
import config from "../config/env.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { Admin } from "../modules/auth/auth.model.js";
import { hashPassword } from "../modules/auth/auth.service.js";
import { ensureRbac, getSuperAdminRole } from "../modules/rbac/rbac.service.js";

const resetPassword = process.argv.includes("--reset-password");

const run = async () => {
    const { name = "Administrator", email, password } = config.seedAdmin;

    if (!email || !password) {
        throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
    }
    if (password.length < 8) {
        throw new Error("ADMIN_PASSWORD must be at least 8 characters");
    }
    if (config.isProduction && /^change_?me/i.test(password)) {
        throw new Error("Refusing to seed a production admin with the example password");
    }

    const normalizedEmail = email.trim().toLowerCase();

    await connectDatabase();
    await Admin.init(); // make sure the unique email index exists before upserting
    await ensureRbac();
    const superAdmin = await getSuperAdminRole();

    const passwordHash = await hashPassword(password);

    // Atomic upsert: concurrent runs cannot create duplicates
    const onInsert = { name, email: normalizedEmail, roleId: superAdmin._id, isActive: true };
    const update = resetPassword
        ? { $setOnInsert: onInsert, $set: { passwordHash } }
        : { $setOnInsert: { ...onInsert, passwordHash } };

    const result = await Admin.updateOne({ email: normalizedEmail }, update, { upsert: true });

    if (result.upsertedCount) {
        console.log(`Admin created: ${normalizedEmail}`);
    } else if (resetPassword) {
        console.log(`Admin already exists, password reset: ${normalizedEmail}`);
    } else {
        console.log(`Admin already exists, nothing changed: ${normalizedEmail}`);
    }
};

try {
    await run();
} catch (error) {
    console.error("Admin seed failed:", error.message);
    process.exitCode = 1;
} finally {
    await disconnectDatabase().catch(() => {});
}
