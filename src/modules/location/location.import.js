/**
 * Parses and imports the Cambodian location hierarchy (Province → District → Commune)
 * from Excel. Used by the admin upload endpoint and by `npm run import:locations`.
 *
 * Supported layouts (detected from the header row, English or Khmer headers):
 *
 *   1. Flat: one row per commune with province / district / commune columns
 *      (e.g. ខេត្ត/ក្រុង · ខណ្ឌ/ស្រុក · ឃុំ/ភូមិ), optionally with code columns.
 *   2. Gazetteer: one row per unit with a Code column and name column(s); the level
 *      comes from the code length (2/4/6, 8 = village is skipped) and the parent from the prefix.
 *
 * Uniqueness: a name may exist only once under the same parent. Names are compared by a
 * normalised key that ignores spaces, zero-width characters, letter case and the
 * interchangeable Khmer subscripts ្ដ / ្ត. This applies within the file and against the
 * database, so re-uploading or uploading a differently-spaced spelling never creates a duplicate.
 *
 * Other rules:
 *   - Text containing Khmer characters is nameKh, Latin text is nameEn. Text is kept as
 *     written apart from NFC normalisation, whitespace collapsing and zero-width removal.
 *   - Flat layout: a row with a child value but blank parent cells (Excel grouping)
 *     inherits the last parent on the same sheet; a district is never inherited across
 *     provinces. Merged cells are read as their master value.
 *   - Numeric codes that lost a leading zero (102) are padded to an even length (0102).
 *   - Without code columns, the name key is stored as the code.
 *   - Re-importing never re-activates a location an admin deactivated and never
 *     rewrites the stored spelling of a name-matched location.
 */
import ExcelJS from "exceljs";
import { cleanText, nameKey } from "../../utils/names.js";
import { Province } from "./province.model.js";
import { District } from "./district.model.js";
import { Commune } from "./commune.model.js";

const KHMER = /[ក-៿᧠-᧿]/;
const LATIN = /[A-Za-z]/;

// ---------- Normalisation ----------

// Shared with Sale GB names; re-exported for existing importers of this module
export { cleanText, nameKey };

export const normalizeCode = (value) => {
    const text = cleanText(value).replace(/\s/g, "");
    if (!text) return "";
    if (/^\d+(\.0+)?$/.test(text)) {
        const digits = text.replace(/\.0+$/, "");
        return digits.length % 2 === 1 ? `0${digits}` : digits;
    }
    return text.toUpperCase();
};

const normalizeHeader = (value) => cleanText(value).toLowerCase().replace(/[\s_\-./()\\:]+/g, "");

// ---------- Header detection ----------

const LEVEL_KEYWORDS = [
    // Order matters: "ឃុំ/ភូមិ" is the commune column, "ស្រុក/ក្រុង/ខណ្ឌ" is a district
    { level: "commune", words: ["commune", "sangkat", "ឃុំ", "សង្កាត់"] },
    { level: "village", words: ["village", "ភូមិ"] },
    { level: "district", words: ["district", "khan", "ស្រុក", "ខណ្ឌ"] },
    { level: "province", words: ["province", "capital", "ខេត្ត", "រាជធានី"] }
];
const CODE_WORDS = ["code", "កូដ", "លេខកូដ"];
const NAME_WORDS = ["name", "ឈ្មោះ", "khmer", "latin", "english", "namekh", "nameen"];
const TYPE_WORDS = ["type", "level", "ប្រភេទ"];

const classifyHeader = (raw) => {
    const norm = normalizeHeader(raw);
    if (!norm) return null;

    const isCode = CODE_WORDS.some((word) => norm.includes(word));
    const level = LEVEL_KEYWORDS.find(({ words }) => words.some((word) => norm.includes(word)))?.level ?? null;

    if (level) return { level, kind: isCode ? "code" : "name" };
    if (isCode) return { level: null, kind: "code" };
    if (TYPE_WORDS.some((word) => norm === word || norm.startsWith(word))) return { level: null, kind: "type" };
    if (NAME_WORDS.some((word) => norm.includes(word))) return { level: null, kind: "name" };
    return null;
};

const detectLayout = (row) => {
    const columns = {
        province: { name: [], code: [] },
        district: { name: [], code: [] },
        commune: { name: [], code: [] },
        village: { name: [], code: [] }
    };
    const generic = { name: [], code: [], type: [] };
    const headers = [];

    row.eachCell({ includeEmpty: false }, (cell, col) => {
        const text = cleanText(cell.text);
        if (!text) return;
        headers.push(text);
        const cls = classifyHeader(text);
        if (!cls) return;
        if (cls.level) columns[cls.level][cls.kind].push(col);
        else generic[cls.kind].push(col);
    });

    // Third level: commune columns, or village-level columns when the source has no commune column
    const childLevel = columns.commune.name.length ? "commune" : columns.village.name.length ? "village" : null;

    if (columns.province.name.length && columns.district.name.length && childLevel) {
        return {
            type: "flat",
            headers,
            childLevel,
            province: columns.province,
            district: columns.district,
            commune: columns[childLevel]
        };
    }

    if (generic.code.length && generic.name.length) {
        return { type: "gazetteer", headers, code: generic.code[0], name: generic.name };
    }

    return { type: null, headers };
};

// ---------- Row readers ----------

const cellText = (row, col) => cleanText(row.getCell(col).text);

const readNames = (row, nameColumns) => {
    let nameKh = "";
    let nameEn = "";
    for (const col of nameColumns) {
        const text = cellText(row, col);
        if (!text) continue;
        if (KHMER.test(text)) nameKh ||= text;
        else if (LATIN.test(text)) nameEn ||= text;
    }
    return { nameKh, nameEn };
};

const readLevel = (row, columns) => ({
    ...readNames(row, columns.name),
    code: columns.code.length ? normalizeCode(row.getCell(columns.code[0]).text) : ""
});

const hasValue = (entry) => Boolean(entry.nameKh || entry.nameEn || entry.code);

// ---------- Collector with dedup + conflict detection ----------

const LEVEL_LABEL = { Province: "province", District: "district", Commune: "commune" };

const createCollector = () => {
    const provinces = new Map();
    const districts = new Map();
    const communes = new Map();
    const invalid = [];
    const warnings = [];
    const duplicates = [];
    const stats = { rowsRead: 0, rowsSkippedBlank: 0, rowsInherited: 0, villagesSkipped: 0, khmerNameMissing: 0 };

    const report = (list, sheet, rowNumber, reason) => list.push({ sheet, row: rowNumber, reason });

    /**
     * Stores an entry under its key. Same key + same spelling is just a repeated parent
     * (normal in flat files). Same name key + different spelling is a duplicate name and is
     * reported, keeping the first spelling. Same real code + different name is a conflict.
     */
    const register = (map, key, entry, where, label) => {
        const existing = map.get(key);
        if (!existing) {
            map.set(key, entry);
            return entry;
        }
        if (existing.nameKh === entry.nameKh && existing.nameEn === entry.nameEn) return existing;

        if (entry.codeFromName) {
            duplicates.push({
                sheet: where.sheet,
                row: where.row,
                level: LEVEL_LABEL[label],
                name: entry.nameKh || entry.nameEn,
                duplicateOf: existing.nameKh || existing.nameEn,
                firstRow: existing.row
            });
            return existing;
        }

        report(
            invalid,
            where.sheet,
            where.row,
            `${label} code ${entry.code} already seen as "${existing.nameKh || existing.nameEn}" but here is "${entry.nameKh || entry.nameEn}"`
        );
        return null;
    };

    const finalize = (entry, where, label) => {
        if (!entry.nameKh && !entry.nameEn) {
            report(invalid, where.sheet, where.row, `${label} has no name`);
            return null;
        }
        if (!entry.nameKh) {
            // Model requires nameKh; fall back to the English name and say so
            stats.khmerNameMissing++;
            if (stats.khmerNameMissing <= 20) {
                report(warnings, where.sheet, where.row, `${label} "${entry.nameEn}" has no Khmer name; English used for nameKh`);
            }
            entry.nameKh = entry.nameEn;
        }
        if (!entry.code) {
            entry.code = nameKey(entry.nameKh);
            entry.codeFromName = true;
        }
        entry.row = where.row;
        return entry;
    };

    return { provinces, districts, communes, invalid, warnings, duplicates, stats, report, register, finalize };
};

// ---------- Layout parsers ----------

/**
 * District name key → the province written next to it elsewhere on the sheet.
 * Only districts that appear under exactly one province are kept, so a blank
 * province can be filled in without guessing.
 */
const provinceByDistrict = (sheet, headerRowNumber, layout) => {
    const found = new Map();
    for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const province = readLevel(row, layout.province);
        const district = readLevel(row, layout.district);
        if (!hasValue(province) || !district.nameKh) continue;

        const key = nameKey(district.nameKh);
        const provinceKey = province.code || nameKey(province.nameKh || province.nameEn);
        const seen = found.get(key);
        if (!seen) found.set(key, { province, provinceKey, row: r });
        else if (seen.provinceKey !== provinceKey) found.set(key, { ambiguous: true });
    }
    return found;
};

const parseFlatSheet = (sheet, headerRowNumber, layout, collector) => {
    const { stats, report, register, finalize, invalid, warnings } = collector;
    const districtProvinces = provinceByDistrict(sheet, headerRowNumber, layout);
    let lastProvince = null;
    let lastDistrict = null;

    for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const where = { sheet: sheet.name, row: r };

        const province = readLevel(row, layout.province);
        const district = readLevel(row, layout.district);
        const commune = readLevel(row, layout.commune);

        if (!hasValue(province) && !hasValue(district) && !hasValue(commune)) {
            stats.rowsSkippedBlank++;
            continue;
        }
        stats.rowsRead++;

        let inherited = false;

        // Province: from this row, or inherited from the grouped rows above
        let storedProvince;
        if (hasValue(province)) {
            const entry = finalize({ ...province }, where, "Province");
            if (!entry) continue;
            storedProvince = register(collector.provinces, entry.code, { ...entry, key: entry.code }, where, "Province");
            if (!storedProvince) continue;
        } else if (lastProvince) {
            storedProvince = lastProvince;
            inherited = true;
        } else {
            // Nothing above to inherit (e.g. the first data row): use the province this
            // district has on other rows, but only when that is unambiguous
            const match = district.nameKh ? districtProvinces.get(nameKey(district.nameKh)) : undefined;
            if (!match || match.ambiguous) {
                report(invalid, where.sheet, r, "Province missing and no previous province to inherit");
                continue;
            }
            const entry = finalize({ ...match.province }, where, "Province");
            if (!entry) continue;
            storedProvince = register(collector.provinces, entry.code, { ...entry, key: entry.code }, where, "Province");
            if (!storedProvince) continue;
            inherited = true;
            report(
                warnings,
                where.sheet,
                r,
                `Province was blank; filled in as "${storedProvince.nameKh}" from row ${match.row} (same district "${district.nameKh}")`
            );
        }

        if (lastProvince !== storedProvince) lastDistrict = null; // never inherit a district across provinces
        lastProvince = storedProvince;

        // District: from this row, inherited only when the row has a commune, otherwise a province-only row
        let storedDistrict;
        if (hasValue(district)) {
            const entry = finalize({ ...district }, where, "District");
            if (!entry) continue;
            if (/^\d+$/.test(entry.code) && /^\d+$/.test(storedProvince.code) && !entry.code.startsWith(storedProvince.code)) {
                report(warnings, where.sheet, r, `District code ${entry.code} does not start with province code ${storedProvince.code}`);
            }
            const key = `${storedProvince.key}|${entry.code}`;
            storedDistrict = register(collector.districts, key, { ...entry, key, provinceKey: storedProvince.key }, where, "District");
            if (!storedDistrict) continue;
        } else if (hasValue(commune) && lastDistrict) {
            storedDistrict = lastDistrict;
            inherited = true;
        } else if (hasValue(commune)) {
            report(invalid, where.sheet, r, "District missing and no previous district in this province to inherit");
            continue;
        } else {
            if (inherited) stats.rowsInherited++;
            continue;
        }

        if (inherited) stats.rowsInherited++;
        lastDistrict = storedDistrict;

        if (!hasValue(commune)) continue; // district-only row

        const entry = finalize({ ...commune }, where, "Commune");
        if (!entry) continue;
        if (/^\d+$/.test(entry.code) && /^\d+$/.test(storedDistrict.code) && !entry.code.startsWith(storedDistrict.code)) {
            report(warnings, where.sheet, r, `Commune code ${entry.code} does not start with district code ${storedDistrict.code}`);
        }
        const key = `${storedDistrict.key}|${entry.code}`;
        register(collector.communes, key, { ...entry, key, districtKey: storedDistrict.key, provinceKey: storedProvince.key }, where, "Commune");
    }
};

const LEVEL_BY_CODE_LENGTH = { 2: "province", 4: "district", 6: "commune", 8: "village" };

const parseGazetteerSheet = (sheet, headerRowNumber, layout, collector) => {
    const { stats, report, register, finalize, invalid } = collector;
    const pendingDistricts = [];
    const pendingCommunes = [];

    for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const where = { sheet: sheet.name, row: r };
        const code = normalizeCode(row.getCell(layout.code).text);
        const names = readNames(row, layout.name);

        if (!code && !names.nameKh && !names.nameEn) {
            stats.rowsSkippedBlank++;
            continue;
        }
        stats.rowsRead++;

        if (!/^\d+$/.test(code)) {
            report(invalid, where.sheet, r, `Invalid or missing code "${code}"`);
            continue;
        }

        const level = LEVEL_BY_CODE_LENGTH[code.length];
        if (!level) {
            report(invalid, where.sheet, r, `Cannot determine level from code "${code}"`);
            continue;
        }
        if (level === "village") {
            stats.villagesSkipped++;
            continue;
        }

        const entry = finalize({ ...names, code }, where, level[0].toUpperCase() + level.slice(1));
        if (!entry) continue;

        if (level === "province") register(collector.provinces, code, { ...entry, key: code }, where, "Province");
        else if (level === "district") pendingDistricts.push({ entry, where });
        else pendingCommunes.push({ entry, where });
    }

    // Parents may appear after children in some files, so resolve prefixes after reading everything
    for (const { entry, where } of pendingDistricts) {
        const provinceKey = entry.code.slice(0, 2);
        if (!collector.provinces.has(provinceKey)) {
            report(invalid, where.sheet, where.row, `District ${entry.code}: parent province ${provinceKey} not found`);
            continue;
        }
        const key = `${provinceKey}|${entry.code}`;
        register(collector.districts, key, { ...entry, key, provinceKey }, where, "District");
    }

    for (const { entry, where } of pendingCommunes) {
        const provinceKey = entry.code.slice(0, 2);
        const districtKey = `${provinceKey}|${entry.code.slice(0, 4)}`;
        if (!collector.districts.has(districtKey)) {
            report(invalid, where.sheet, where.row, `Commune ${entry.code}: parent district ${entry.code.slice(0, 4)} not found`);
            continue;
        }
        const key = `${districtKey}|${entry.code}`;
        register(collector.communes, key, { ...entry, key, districtKey, provinceKey }, where, "Commune");
    }
};

// ---------- Workbook parsing ----------

const HEADER_SCAN_ROWS = 30;

/** `source` is a file path or a Buffer (uploaded file). */
export const parseWorkbook = async (source, { sheet: sheetName } = {}) => {
    const workbook = new ExcelJS.Workbook();
    if (Buffer.isBuffer(source)) await workbook.xlsx.load(source);
    else await workbook.xlsx.readFile(source);

    const collector = createCollector();
    const sheetsUsed = [];
    const sheetsSkipped = [];

    const sheets = sheetName ? [workbook.getWorksheet(sheetName)].filter(Boolean) : workbook.worksheets;
    if (sheetName && sheets.length === 0) throw new Error(`Sheet "${sheetName}" not found`);

    for (const sheet of sheets) {
        let found = null;
        let lastHeaders = [];
        for (let r = 1; r <= Math.min(sheet.rowCount, HEADER_SCAN_ROWS); r++) {
            const layout = detectLayout(sheet.getRow(r));
            if (layout.headers.length) lastHeaders = layout.headers;
            if (layout.type) {
                found = { row: r, layout };
                break;
            }
        }

        if (!found) {
            sheetsSkipped.push({ name: sheet.name, headers: lastHeaders });
            continue;
        }

        sheetsUsed.push({ name: sheet.name, layout: found.layout.type, headerRow: found.row, childLevel: found.layout.childLevel });

        if (found.layout.type === "flat") parseFlatSheet(sheet, found.row, found.layout, collector);
        else parseGazetteerSheet(sheet, found.row, found.layout, collector);
    }

    return { ...collector, sheetsUsed, sheetsSkipped };
};

// ---------- Database sync ----------

const emptyStats = () => ({ created: 0, updated: 0, unchanged: 0, matchedByName: 0 });

/**
 * Syncs one level. Each parsed entry is matched to an existing document under the same
 * parent by code first, then by name key (so "ភ្នំ ពេញ" matches an existing "ភ្នំពេញ").
 * Returns stats and a map from the parsed entry key to the document id for the next level.
 * With `dryRun`, nothing is written; children of new parents count as new.
 */
const syncLevel = async (Model, { entries, parentField, parentIdOf, extraFor = () => ({}), dryRun }) => {
    const stats = emptyStats();
    const ids = new Map();

    const parentIds = parentField
        ? [...new Set(entries.map(parentIdOf).filter(Boolean).map(String))]
        : null;
    const existingDocs = await Model.find(parentField ? { [parentField]: { $in: parentIds } } : {}).lean();

    const scope = (doc) => (parentField ? String(doc[parentField]) : "");
    const byCode = new Map(existingDocs.map((doc) => [`${scope(doc)}|${doc.code}`, doc]));
    const byName = new Map(existingDocs.map((doc) => [`${scope(doc)}|${nameKey(doc.nameKh)}`, doc]));

    const ops = [];
    const toCreate = [];

    for (const entry of entries) {
        const parentId = parentField ? parentIdOf(entry) : undefined;
        const extra = extraFor(entry);

        if (parentField && !parentId) {
            // Parent is new in this (dry) run, so the child is new too
            stats.created++;
            continue;
        }

        const prefix = parentField ? String(parentId) : "";
        const byCodeMatch = byCode.get(`${prefix}|${entry.code}`);
        const match = byCodeMatch ?? byName.get(`${prefix}|${nameKey(entry.nameKh)}`);

        if (!match) {
            const filter = { ...(parentField ? { [parentField]: parentId } : {}), code: entry.code };
            ops.push({
                updateOne: {
                    filter,
                    update: { $set: { nameKh: entry.nameKh, nameEn: entry.nameEn, ...extra }, $setOnInsert: { isActive: true } },
                    upsert: true
                }
            });
            toCreate.push({ entry, filter });
            stats.created++;
            continue;
        }

        if (!byCodeMatch) stats.matchedByName++;
        ids.set(entry.key, match._id);

        // Name-keyed entries keep the stored spelling; only fill in a missing English name
        const changes = entry.codeFromName
            ? { ...(entry.nameEn && entry.nameEn !== match.nameEn ? { nameEn: entry.nameEn } : {}) }
            : {
                  ...(entry.nameKh !== match.nameKh ? { nameKh: entry.nameKh } : {}),
                  ...(entry.nameEn !== (match.nameEn ?? "") ? { nameEn: entry.nameEn } : {})
              };
        for (const [field, value] of Object.entries(extra)) {
            if (String(match[field]) !== String(value)) changes[field] = value;
        }

        if (Object.keys(changes).length) {
            ops.push({ updateOne: { filter: { _id: match._id }, update: { $set: changes } } });
            stats.updated++;
        } else {
            stats.unchanged++;
        }
    }

    if (!dryRun) {
        for (let i = 0; i < ops.length; i += 1000) {
            await Model.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
        }
        if (toCreate.length) {
            const created = await Model.find({ $or: toCreate.map(({ filter }) => filter) }).select("_id code " + (parentField ?? "")).lean();
            const createdByKey = new Map(created.map((doc) => [`${scope(doc)}|${doc.code}`, doc._id]));
            for (const { entry, filter } of toCreate) {
                const id = createdByKey.get(`${parentField ? String(filter[parentField]) : ""}|${entry.code}`);
                if (id) ids.set(entry.key, id);
            }
        }
    }

    return { stats, ids };
};

export const syncLocations = async ({ provinces, districts, communes }, { dryRun = false } = {}) => {
    if (!dryRun) await Promise.all([Province.init(), District.init(), Commune.init()]);

    const province = await syncLevel(Province, { entries: [...provinces.values()], dryRun });

    const district = await syncLevel(District, {
        entries: [...districts.values()],
        parentField: "provinceId",
        parentIdOf: (d) => province.ids.get(d.provinceKey),
        dryRun
    });

    const commune = await syncLevel(Commune, {
        entries: [...communes.values()],
        parentField: "districtId",
        parentIdOf: (c) => district.ids.get(c.districtKey),
        extraFor: (c) => ({ provinceId: province.ids.get(c.provinceKey) }),
        dryRun
    });

    return { provinces: province.stats, districts: district.stats, communes: commune.stats };
};
