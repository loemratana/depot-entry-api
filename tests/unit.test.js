import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import "./helpers.js";

const { normalizePhone, isValidPhone, personName } = await import("../src/utils/validators.js");
const { generateSubmissionNo } = await import("../src/modules/submission/submission.service.js");
const { detectFileType } = await import("../src/modules/upload/file.validation.js");
const { cleanText, normalizeCode, parseWorkbook } = await import("../src/modules/location/location.import.js");
const ExcelJS = (await import("exceljs")).default;

describe("phone validation", () => {
    test("accepts 9 and 10 digit local numbers starting with 0", () => {
        assert.equal(isValidPhone("012345678"), true);
        assert.equal(isValidPhone("0123456789"), true);
    });

    test("normalises spaces, dashes, dots and the +855 prefix", () => {
        assert.equal(normalizePhone(" 012 345-678 "), "012345678");
        assert.equal(normalizePhone("(012) 345.678"), "012345678");
        assert.equal(normalizePhone("+855 12 345 678"), "012345678");
        assert.equal(normalizePhone("855969999999"), "0969999999");
    });

    test("rejects wrong length, missing leading 0 and letters", () => {
        for (const bad of ["01234567", "01234567890", "123456789", "01234567a", ""]) {
            assert.equal(isValidPhone(bad), false, bad);
        }
    });
});

describe("client name validation", () => {
    const schema = personName("Client name");

    test("accepts Khmer names with combining marks and subscripts", () => {
        for (const name of ["សុខា", "ស្រីនាង", "ចន្ទ្រា ពេជ្រ", "ឆ្លាំ"]) {
            assert.equal(schema.safeParse(name).success, true, name);
        }
    });

    test("trims and collapses whitespace", () => {
        assert.equal(schema.parse("  Sok    Dara "), "Sok Dara");
    });

    test("requires at least 2 characters after trimming", () => {
        assert.equal(schema.safeParse(" a ").success, false);
        assert.equal(schema.safeParse("   ").success, false);
    });
});

describe("submission number", () => {
    test("has the CL-YYYYMMDD-XXXXXXXX format using business-local date", () => {
        // 2026-09-28T20:00Z is already 29 September in Cambodia (+07:00)
        const no = generateSubmissionNo(new Date("2026-09-28T20:00:00Z"));
        assert.match(no, /^CL-20260929-[0-9A-HJKMNP-TV-Z]{8}$/);
    });

    test("does not repeat across many generations", () => {
        const set = new Set(Array.from({ length: 20000 }, () => generateSubmissionNo()));
        assert.equal(set.size, 20000);
    });
});

describe("file signature detection", () => {
    const write = async (name, bytes) => {
        const file = path.join(os.tmpdir(), `sig-${process.pid}-${name}`);
        await fs.writeFile(file, bytes);
        return file;
    };

    test("detects allowed types by content", async () => {
        assert.equal((await detectFileType(await write("a", Buffer.from("%PDF-1.7 x")))).mimeType, "application/pdf");
        assert.equal((await detectFileType(await write("b", Buffer.from([0xff, 0xd8, 0xff, 0xdb])))).mimeType, "image/jpeg");
        assert.equal((await detectFileType(await write("c", Buffer.from("RIFF\0\0\0\0WEBPVP8 ")))).mimeType, "image/webp");
    });

    test("returns null for unknown content", async () => {
        assert.equal(await detectFileType(await write("d", Buffer.from("<html></html>"))), null);
    });
});

describe("export thumbnails", () => {
    test("reads PNG and JPEG dimensions from the file header", async () => {
        const { imageSize } = await import("../src/modules/export/export.service.js");

        const png = Buffer.alloc(33);
        png.writeUInt32BE(0x89504e47, 0);
        png.writeUInt32BE(640, 16);
        png.writeUInt32BE(480, 20);
        assert.deepEqual(imageSize(png), { width: 640, height: 480 });

        // SOI, then an APP0 segment, then SOF0 with height 300 / width 400
        const jpeg = Buffer.from([
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
            0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03
        ]);
        assert.deepEqual(imageSize(jpeg), { width: 400, height: 300 });

        assert.equal(imageSize(Buffer.from("%PDF-1.4")), null);
    });
});

describe("location import parsing", () => {
    test("cleanText removes zero-width characters and normalises whitespace", () => {
        assert.equal(cleanText("  ភ្នំ\u200Bពេញ  \n "), "ភ្នំពេញ");
    });

    test("normalizeCode restores leading zeros lost in Excel", () => {
        assert.equal(normalizeCode(1), "01");
        assert.equal(normalizeCode("102"), "0102");
        assert.equal(normalizeCode("010203"), "010203");
        assert.equal(normalizeCode(" 12 "), "12");
    });

    const writeWorkbook = async (rows, name) => {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Data");
        rows.forEach((row) => sheet.addRow(row));
        const file = path.join(os.tmpdir(), `locations-${process.pid}-${name}.xlsx`);
        await workbook.xlsx.writeFile(file);
        return file;
    };

    test("flat layout: inherits grouped parents, dedups, reports invalid rows and conflicts", async () => {
        const file = await writeWorkbook(
            [
                ["Title row that is not a header"],
                ["Province Code", "ខេត្ត", "Province", "District Code", "ស្រុក", "District", "Commune Code", "ឃុំ", "Commune"],
                [1, "ខេត្តក", "Province A", 101, "ស្រុកក", "District A", 10101, "ឃុំក", "Commune A"],
                [null, null, null, null, null, null, 10102, "ឃុំខ", "Commune B"], // grouped rows: inherit parents
                [1, "ខេត្តក", "Province A", 101, "ស្រុកក", "District A", 10101, "ឃុំក", "Commune A"], // exact duplicate
                [1, "ខេត្តក", "Province A", 101, "ស្រុកក", "District A", 10101, "ឃុំផ្សេង", "Other"], // conflicting name
                [2, "ខេត្តខ", "Province B", 201, "ស្រុកខ", "District B", 20101, "ឃុំគ", "Commune C"],
                [],
                [3, "ខេត្តគ", "Province C", 301, "ស្រុកគ", "District C", null, null, null], // district-only row
                [4, "ខេត្តឃ", "Province D", 401, "ស្រុកឃ", "District D", 40101, null, null] // commune code but no name
            ],
            "flat"
        );

        const result = await parseWorkbook(file);

        assert.equal(result.sheetsUsed[0].layout, "flat");
        assert.equal(result.sheetsUsed[0].headerRow, 2);
        assert.equal(result.provinces.size, 4);
        assert.equal(result.districts.size, 4);
        assert.equal(result.communes.size, 3);
        assert.equal(result.stats.rowsInherited, 1);
        assert.deepEqual(
            result.invalid.map((i) => [i.row, i.reason.replace(/ code .*/, "")]),
            [
                [6, "Commune"],
                [10, "Commune has no name"]
            ]
        );
        assert.match(result.invalid[0].reason, /already seen/);

        const inherited = result.communes.get("01|0101|010102");
        assert.equal(inherited.nameKh, "ឃុំខ");
        assert.equal(inherited.nameEn, "Commune B");
    });

    test("flat layout: a blank province on the first row is filled from the same district below", async () => {
        const file = await writeWorkbook(
            [
                ["ខេត្ត/ក្រុង", "ខ័ណ្ឌ/ស្រុក", "ឃុំ/ភូមិ"],
                [" ", "ខណ្ឌចំការមន", "សង្កាត់ទន្លេបាសាក់"],
                ["ភ្នំពេញ", "ខណ្ឌចំការមន", "សង្កាត់ទួលទំពូងទី ២"]
            ],
            "first-row-blank"
        );
        const result = await parseWorkbook(file);
        assert.deepEqual(result.invalid, []);
        assert.equal(result.provinces.size, 1);
        assert.equal(result.communes.size, 2);
        assert.match(result.warnings[0].reason, /filled in as "ភ្នំពេញ" from row 3/);
    });

    test("flat layout: a blank province is not guessed when the district name exists in two provinces", async () => {
        const file = await writeWorkbook(
            [
                ["ខេត្ត/ក្រុង", "ខ័ណ្ឌ/ស្រុក", "ឃុំ/ភូមិ"],
                [null, "ស្រុកដូចគ្នា", "ឃុំក"],
                ["ខេត្តក", "ស្រុកដូចគ្នា", "ឃុំខ"],
                ["ខេត្តខ", "ស្រុកដូចគ្នា", "ឃុំគ"]
            ],
            "ambiguous"
        );
        const result = await parseWorkbook(file);
        assert.equal(result.invalid.length, 1);
        assert.match(result.invalid[0].reason, /Province missing/);
    });

    test("flat layout: a row without any parent to inherit is reported, not guessed", async () => {
        const file = await writeWorkbook(
            [
                ["Province", "District", "Commune"],
                [null, null, "ឃុំក"]
            ],
            "orphan"
        );
        const result = await parseWorkbook(file);
        assert.equal(result.communes.size, 0);
        assert.match(result.invalid[0].reason, /Province missing/);
    });

    test("gazetteer layout: level from code length, parent from prefix, villages skipped", async () => {
        const file = await writeWorkbook(
            [
                ["Type", "Code", "Name (Khmer)", "Name (Latin)"],
                ["ខេត្ត", 1, "ខេត្តក", "Province A"],
                ["ស្រុក", 102, "ស្រុកក", "District A"],
                ["ឃុំ", 10201, "ឃុំក", "Commune A"],
                ["ភូមិ", 1020101, "ភូមិក", "Village A"],
                ["ឃុំ", 99999, "ឃុំអត់មេ", "Orphan"]
            ],
            "gazetteer"
        );

        const result = await parseWorkbook(file);

        assert.equal(result.sheetsUsed[0].layout, "gazetteer");
        assert.equal(result.provinces.size, 1);
        assert.equal(result.districts.size, 1);
        assert.equal(result.communes.size, 1);
        assert.equal(result.stats.villagesSkipped, 1);
        assert.equal(result.invalid.length, 1);
        assert.match(result.invalid[0].reason, /parent district/);
        assert.ok(result.communes.has("01|0102|010201"));
    });
});
