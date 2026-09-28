/**
 * Integration test harness. Runs against the local Docker MongoDB and MinIO,
 * but in a separate database and bucket so development data is never touched.
 * Must be imported before anything that loads src/config/env.js.
 */
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const TEST_DB = "client_management_test";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);
process.env.MINIO_BUCKET = "client-documents-test";
process.env.MAX_FILE_SIZE_MB = "1";
process.env.MAX_FILES_PER_SUBMISSION = "3";
process.env.ADMIN_EMAIL = "test-admin@example.com";
process.env.ADMIN_PASSWORD = "test-password-123";

if (!process.env.MONGODB_URI.includes(`/${TEST_DB}`)) {
    throw new Error("Refusing to run tests: could not point MONGODB_URI at the test database");
}

const mongoose = (await import("mongoose")).default;
const { connectDatabase, disconnectDatabase } = await import("../src/config/database.js");
const { ensureBucket, minioClient, BUCKET } = await import("../src/config/minio.js");
const { default: app } = await import("../src/app.js");
const { Admin } = await import("../src/modules/auth/auth.model.js");
const { hashPassword } = await import("../src/modules/auth/auth.service.js");
const { Province } = await import("../src/modules/location/province.model.js");
const { District } = await import("../src/modules/location/district.model.js");
const { Commune } = await import("../src/modules/location/commune.model.js");
const { Sale } = await import("../src/modules/sale/sale.model.js");
const { Submission } = await import("../src/modules/submission/submission.model.js");

export { mongoose, minioClient, BUCKET, Admin, Province, District, Commune, Sale, Submission };

export const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };

let server;
export let baseUrl;

const emptyBucket = async () => {
    const keys = [];
    for await (const item of minioClient.listObjectsV2(BUCKET, "", true)) keys.push(item.name);
    if (keys.length) await minioClient.removeObjects(BUCKET, keys);
};

export const listBucketKeys = async (prefix = "") => {
    const keys = [];
    for await (const item of minioClient.listObjectsV2(BUCKET, prefix, true)) keys.push(item.name);
    return keys;
};

export const start = async () => {
    await connectDatabase();
    await mongoose.connection.dropDatabase();
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).syncIndexes()));
    await ensureBucket();
    await emptyBucket();

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
};

export const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await emptyBucket();
    await disconnectDatabase();
};

export const api = async (path, { method = "GET", token, json, form, headers = {} } = {}) => {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (json !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(json);
    }
    if (form) init.body = form;

    const res = await fetch(`${baseUrl}${path}`, init);
    const type = res.headers.get("content-type") || "";
    const body = type.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body };
};

// ---------- Fixtures ----------

export const createAdmin = async () =>
    Admin.create({ name: "Test Admin", email: ADMIN.email, passwordHash: await hashPassword(ADMIN.password) });

export const login = async () => {
    const { body } = await api("/admin/auth/login", { method: "POST", json: ADMIN });
    return body.data.token;
};

/**
 * Two provinces, each with one district and one commune, plus one inactive
 * commune and two Sale GB entries (one inactive). Names are test placeholders.
 */
export const createLocations = async () => {
    const [p1, p2] = await Province.create([
        { code: "01", nameKh: "ខេត្តតេស្តមួយ", nameEn: "Test Province One" },
        { code: "02", nameKh: "ខេត្តតេស្តពីរ", nameEn: "Test Province Two" }
    ]);
    const [d1, d2] = await District.create([
        { provinceId: p1._id, code: "0101", nameKh: "ស្រុកតេស្តមួយ", nameEn: "Test District One" },
        { provinceId: p2._id, code: "0201", nameKh: "ស្រុកតេស្តពីរ", nameEn: "Test District Two" }
    ]);
    const [c1, c2, cInactive] = await Commune.create([
        { provinceId: p1._id, districtId: d1._id, code: "010101", nameKh: "ឃុំតេស្តមួយ", nameEn: "Test Commune One" },
        { provinceId: p2._id, districtId: d2._id, code: "020101", nameKh: "ឃុំតេស្តពីរ", nameEn: "Test Commune Two" },
        { provinceId: p1._id, districtId: d1._id, code: "010102", nameKh: "ឃុំបិទ", nameEn: "Closed Commune", isActive: false }
    ]);
    const [sale, inactiveSale] = await Sale.create([
        { name: "Test Sale A", code: "TSA" },
        { name: "Test Sale B", code: "TSB", isActive: false }
    ]);
    return { p1, p2, d1, d2, c1, c2, cInactive, sale, inactiveSale };
};

// Smallest byte sequences that pass signature detection
export const FILES = {
    png: () => new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])], { type: "image/png" }),
    jpg: () => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])], { type: "image/jpeg" }),
    pdf: () => new Blob([Buffer.from("%PDF-1.4\n%test\n")], { type: "application/pdf" }),
    text: () => new Blob([Buffer.from("just some text")], { type: "text/plain" }),
    fakePng: () => new Blob([Buffer.from("not really a png file")], { type: "image/png" }),
    oversized: () => new Blob([Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1024 * 1024 + 10)])], { type: "application/pdf" })
};

export const submissionForm = (fields, files = [["doc.png", FILES.png()]]) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) form.append(key, String(value));
    }
    for (const [name, blob] of files) form.append("files", blob, name);
    return form;
};

export const validFields = (fx, overrides = {}) => ({
    clientName: "សុខា ចាន់",
    phone: "012 345 678",
    provinceId: fx.p1._id,
    districtId: fx.d1._id,
    communeId: fx.c1._id,
    saleGbId: fx.sale._id,
    ...overrides
});
