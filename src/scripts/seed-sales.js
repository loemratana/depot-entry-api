/**
 * Upserts Sale GB entries from a JSON file (default: data/sales.json,
 * falling back to data/sales.example.json). Entries are matched by `code`,
 * so the script is safe to run repeatedly.
 *
 *   npm run seed:sales
 *   npm run seed:sales -- path/to/sales.json
 *
 * File format: [{ "name": "...", "code": "GB01", "phone": "012345678" }, ...]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { Sale } from "../modules/sale/sale.model.js";
import { personName, phone } from "../utils/validators.js";

const DATA_DIR = path.resolve("data");

const entrySchema = z.object({
    name: personName("name", { min: 1, max: 150 }),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,30}$/, "code is required (letters, numbers, - _)"),
    phone: phone().optional(),
    isActive: z.boolean().optional()
});

const resolveFile = async () => {
    const argPath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
    if (argPath) return path.resolve(argPath);

    for (const candidate of ["sales.json", "sales.example.json"]) {
        const filePath = path.join(DATA_DIR, candidate);
        try {
            await fs.access(filePath);
            return filePath;
        } catch {
            // try next
        }
    }
    throw new Error("No sales file found. Create data/sales.json or pass a path");
};

const run = async () => {
    const filePath = await resolveFile();
    const entries = JSON.parse(await fs.readFile(filePath, "utf8"));

    if (!Array.isArray(entries)) throw new Error("Sales file must contain a JSON array");

    const valid = [];
    const invalid = [];
    const seenCodes = new Set();

    entries.forEach((entry, index) => {
        const result = entrySchema.safeParse(entry);
        if (!result.success) {
            invalid.push({ index, reason: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        } else if (seenCodes.has(result.data.code)) {
            invalid.push({ index, reason: `duplicate code ${result.data.code} in file` });
        } else {
            seenCodes.add(result.data.code);
            valid.push(result.data);
        }
    });

    console.log(`Reading ${path.relative(process.cwd(), filePath)}: ${valid.length} valid, ${invalid.length} invalid`);
    invalid.forEach(({ index, reason }) => console.warn(`  entry #${index}: ${reason}`));

    if (valid.length === 0) return;

    await connectDatabase();
    await Sale.init();

    const result = await Sale.bulkWrite(
        valid.map(({ code, isActive, ...fields }) => ({
            updateOne: {
                filter: { code },
                update: {
                    $set: fields,
                    $setOnInsert: { code, isActive: isActive ?? true }
                },
                upsert: true
            }
        })),
        { ordered: false }
    );

    console.log(`Sale GB: ${result.upsertedCount} created, ${result.modifiedCount} updated, ${result.matchedCount - result.modifiedCount} unchanged`);
};

try {
    await run();
} catch (error) {
    console.error("Sales seed failed:", error.message);
    process.exitCode = 1;
} finally {
    await disconnectDatabase().catch(() => {});
}
