/**
 * Imports the Cambodian location hierarchy from Excel. Same logic as the admin
 * "Locations" upload page (see src/modules/location/location.import.js).
 *
 *   npm run import:locations                          # reads data/location.xlsx
 *   npm run import:locations -- path/to/file.xlsx
 *   npm run import:locations -- file.xlsx --dry-run   # parse + compare, no DB writes
 *   npm run import:locations -- file.xlsx --sheet "Sheet1" --strict
 */
import path from "node:path";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { parseWorkbook, syncLocations } from "../modules/location/location.import.js";

const MAX_REPORTED_ROWS = 100;

const parseArgs = (argv) => {
    const args = { file: null, sheet: null, dryRun: false, strict: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") args.dryRun = true;
        else if (arg === "--strict") args.strict = true;
        else if (arg === "--sheet") args.sheet = argv[++i];
        else if (!arg.startsWith("--")) args.file = arg;
    }
    args.file = path.resolve(args.file || "data/location.xlsx");
    return args;
};

const printRows = (title, rows, format) => {
    if (!rows.length) return;
    console.log(`\n${title} (${rows.length}):`);
    rows.slice(0, MAX_REPORTED_ROWS).forEach((row) => console.log(`  ${format(row)}`));
    if (rows.length > MAX_REPORTED_ROWS) console.log(`  ... and ${rows.length - MAX_REPORTED_ROWS} more`);
};

const summarize = (label, { created, updated, unchanged, matchedByName }) =>
    `${label}: ${created} new, ${updated} updated, ${unchanged} unchanged` +
    (matchedByName ? ` (${matchedByName} matched an existing name)` : "");

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    console.log(`Reading ${args.file}${args.dryRun ? " (dry run)" : ""}`);

    const parsed = await parseWorkbook(args.file, { sheet: args.sheet });

    for (const s of parsed.sheetsUsed) {
        console.log(`  Sheet "${s.name}": ${s.layout} layout, header on row ${s.headerRow}${s.childLevel === "village" ? " (third level taken from village column)" : ""}`);
    }
    for (const s of parsed.sheetsSkipped) {
        console.log(`  Sheet "${s.name}": skipped, no recognised header. Headers seen: ${s.headers.join(" | ") || "(none)"}`);
    }

    if (parsed.sheetsUsed.length === 0) {
        throw new Error(
            "No sheet with a recognised header. Expected columns such as ខេត្ត/ក្រុង · ខណ្ឌ/ស្រុក · ឃុំ/ភូមិ " +
                "(or Province / District / Commune), optionally with Code columns."
        );
    }

    const { stats } = parsed;
    console.log("\nParsed:");
    console.log(`  Rows read:           ${stats.rowsRead}`);
    console.log(`  Blank rows skipped:  ${stats.rowsSkippedBlank}`);
    console.log(`  Rows with inherited parent (grouped cells): ${stats.rowsInherited}`);
    if (stats.villagesSkipped) console.log(`  Village rows skipped: ${stats.villagesSkipped}`);
    if (stats.khmerNameMissing) console.log(`  Entries without Khmer name: ${stats.khmerNameMissing}`);
    console.log(`  Unique provinces:    ${parsed.provinces.size}`);
    console.log(`  Unique districts:    ${parsed.districts.size}`);
    console.log(`  Unique communes:     ${parsed.communes.size}`);

    printRows("Duplicate names merged (first spelling kept)", parsed.duplicates, (d) =>
        `[${d.sheet}] row ${d.row}: ${d.level} "${d.name}" = "${d.duplicateOf}" (row ${d.firstRow})`
    );
    printRows("Invalid rows (not imported)", parsed.invalid, (r) => `[${r.sheet}] row ${r.row}: ${r.reason}`);
    printRows("Warnings", parsed.warnings, (r) => `[${r.sheet}] row ${r.row}: ${r.reason}`);

    if (args.strict && parsed.invalid.length) {
        throw new Error(`--strict: ${parsed.invalid.length} invalid row(s); nothing was written`);
    }

    await connectDatabase();
    const result = await syncLocations(parsed, { dryRun: args.dryRun });

    console.log(args.dryRun ? "\nCompared with database (dry run, nothing written):" : "\nDatabase:");
    console.log(`  ${summarize("Provinces", result.provinces)}`);
    console.log(`  ${summarize("Districts", result.districts)}`);
    console.log(`  ${summarize("Communes ", result.communes)}`);
};

try {
    await main();
} catch (error) {
    console.error("\nLocation import failed:", error.message);
    process.exitCode = 1;
} finally {
    await disconnectDatabase().catch(() => {});
}
