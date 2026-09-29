/**
 * Fills the development database with demo data: a few provinces/districts/communes,
 * Sale GB entries and client submissions with real image/PDF files in MinIO.
 * Every demo record uses a code starting with "DEMO", so it can be removed cleanly.
 *
 *   npm run seed:sample                  # 60 submissions
 *   npm run seed:sample -- --count 200
 *   npm run seed:sample -- --use-existing-locations   # spread over imported locations, no demo locations
 *   npm run seed:sample -- --clear       # remove all demo data and files
 *
 * --clear only removes demo records nothing real depends on. Demo locations that a real
 * location import matched by name (and attached real districts/communes to) are kept.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import mongoose from "mongoose";
import config from "../config/env.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { ensureBucket, minioClient, BUCKET } from "../config/minio.js";
import { nameKey } from "../modules/location/location.import.js";
import { Province } from "../modules/location/province.model.js";
import { District } from "../modules/location/district.model.js";
import { Commune } from "../modules/location/commune.model.js";
import { Sale } from "../modules/sale/sale.model.js";
import { Submission } from "../modules/submission/submission.model.js";
import { generateSubmissionNo } from "../modules/submission/submission.service.js";
import { uploadSubmissionFiles } from "../modules/upload/upload.service.js";

const DEMO = /^DEMO/;

const LOCATIONS = [
    {
        code: "DEMO-12", nameKh: "រាជធានីភ្នំពេញ", nameEn: "Phnom Penh",
        districts: [
            { code: "DEMO-1201", nameKh: "ខណ្ឌចំការមន", nameEn: "Chamkar Mon", communes: [["DEMO-120101", "សង្កាត់ទន្លេបាសាក់", "Tonle Basak"], ["DEMO-120102", "សង្កាត់បឹងកេងកងទី១", "Boeng Keng Kang Ti Muoy"], ["DEMO-120103", "សង្កាត់ទួលទំពូងទី១", "Tuol Tumpung Ti Muoy"]] },
            { code: "DEMO-1202", nameKh: "ខណ្ឌដូនពេញ", nameEn: "Doun Penh", communes: [["DEMO-120201", "សង្កាត់ផ្សារថ្មីទី១", "Phsar Thmei Ti Muoy"], ["DEMO-120202", "សង្កាត់វត្តភ្នំ", "Voat Phnum"]] },
            { code: "DEMO-1203", nameKh: "ខណ្ឌសែនសុខ", nameEn: "Sen Sok", communes: [["DEMO-120301", "សង្កាត់ទឹកថ្លា", "Tuek Thla"], ["DEMO-120302", "សង្កាត់ភ្នំពេញថ្មី", "Phnom Penh Thmei"]] }
        ]
    },
    {
        code: "DEMO-17", nameKh: "ខេត្តសៀមរាប", nameEn: "Siem Reap",
        districts: [
            { code: "DEMO-1710", nameKh: "ក្រុងសៀមរាប", nameEn: "Siem Reap City", communes: [["DEMO-171001", "សង្កាត់ស្លក្រាម", "Sla Kram"], ["DEMO-171002", "សង្កាត់ស្វាយដង្គំ", "Svay Dankum"]] },
            { code: "DEMO-1703", nameKh: "ស្រុកពួក", nameEn: "Puok", communes: [["DEMO-170301", "ឃុំពួក", "Puok"], ["DEMO-170302", "ឃុំកែវពណ៌", "Kaev Poar"]] }
        ]
    },
    {
        code: "DEMO-02", nameKh: "ខេត្តបាត់ដំបង", nameEn: "Battambang",
        districts: [
            { code: "DEMO-0203", nameKh: "ក្រុងបាត់ដំបង", nameEn: "Battambang City", communes: [["DEMO-020301", "សង្កាត់ស្វាយប៉ោ", "Svay Pao"], ["DEMO-020302", "សង្កាត់រតនៈ", "Rottanak"]] },
            { code: "DEMO-0201", nameKh: "ស្រុកបាណន់", nameEn: "Banan", communes: [["DEMO-020101", "ឃុំកន្ទឺ ១", "Kantueu Muoy"]] }
        ]
    },
    {
        code: "DEMO-18", nameKh: "ខេត្តព្រះសីហនុ", nameEn: "Preah Sihanouk",
        districts: [
            { code: "DEMO-1801", nameKh: "ក្រុងព្រះសីហនុ", nameEn: "Preah Sihanouk City", communes: [["DEMO-180101", "សង្កាត់លេខ១", "Muoy"], ["DEMO-180102", "សង្កាត់លេខ២", "Pir"]] }
        ]
    },
    {
        code: "DEMO-08", nameKh: "ខេត្តកណ្ដាល", nameEn: "Kandal",
        districts: [
            { code: "DEMO-0810", nameKh: "ក្រុងតាខ្មៅ", nameEn: "Ta Khmau", communes: [["DEMO-081001", "សង្កាត់តាខ្មៅ", "Ta Khmau"], ["DEMO-081002", "សង្កាត់ព្រែកឫស្សី", "Preaek Ruessei"]] }
        ]
    }
];

const SALES = [
    ["DEMO01", "Sok Dara", "012345601"],
    ["DEMO02", "Chan Sophea", "012345602"],
    ["DEMO03", "Kim Vannak", "012345603"],
    ["DEMO04", "Lim Sreyneang", "012345604"],
    ["DEMO05", "Heng Rithy", "012345605"]
];

const FIRST_NAMES = ["សុខា", "ដារ៉ា", "សុភា", "វណ្ណា", "ស្រីនាង", "ចន្ទ្រា", "រិទ្ធី", "សុភ័ក្ត្រ", "បូរ៉ា", "ពិសិដ្ឋ", "Dara", "Sophea", "Vannak", "Rithy", "Channary", "Pisey"];
const LAST_NAMES = ["ចាន់", "សុខ", "ពេជ្រ", "មាស", "លឹម", "ហេង", "គីម", "Chan", "Sok", "Kim", "Lim", "Heng", "Chea"];
const PHONE_PREFIXES = ["010", "012", "015", "016", "017", "069", "070", "077", "078", "085", "086", "087", "088", "089", "092", "093", "095", "096", "097", "098", "099"];

// ---------- Demo file generation ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
};

// An ID-card-like picture: coloured header band, photo box and text lines
const makePng = (seed) => {
    const width = 480;
    const height = 300;
    const hue = [
        [37, 99, 235], [22, 163, 74], [202, 138, 4], [219, 39, 119], [124, 58, 237], [8, 145, 178]
    ][seed % 6];

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB

    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = y * (width * 3 + 1) + 1 + x * 3;
            let color = [248, 250, 252];
            if (y < 60) color = hue;
            else if (x > 30 && x < 150 && y > 90 && y < 250) color = [203, 213, 225];
            else if (x > 180 && x < 440 && [110, 150, 190, 230].some((line) => y > line && y < line + 12)) {
                color = x < 180 + ((seed * 37 + y) % 200) + 60 ? [148, 163, 184] : color;
            }
            raw[o] = color[0];
            raw[o + 1] = color[1];
            raw[o + 2] = color[2];
        }
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", zlib.deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0))
    ]);
};

// Minimal valid one-page PDF with a line of text
const makePdf = (title) => {
    const text = title.replace(/[()\\]/g, "");
    const stream = `BT /F1 18 Tf 60 740 Td (${text}) Tj ET BT /F1 11 Tf 60 710 Td (Sample document generated by seed:sample) Tj ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [];
    objects.forEach((body, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, "latin1");
};

// ---------- Helpers ----------

const pick = (list) => list[crypto.randomInt(list.length)];

const randomPhone = () => {
    const prefix = pick(PHONE_PREFIXES);
    const length = prefix === "012" || prefix === "010" ? 6 : crypto.randomInt(2) ? 7 : 6;
    return prefix + Array.from({ length }, () => crypto.randomInt(10)).join("");
};

// Spread over the last 60 days, during office hours in Cambodia (UTC+7)
const randomSubmittedAt = () => {
    const daysAgo = crypto.randomInt(60);
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysAgo);
    date.setUTCHours(1 + crypto.randomInt(10), crypto.randomInt(60), crypto.randomInt(60), 0);
    return date > new Date() ? new Date(Date.now() - crypto.randomInt(3600) * 1000) : date;
};

const parseCount = () => {
    const index = process.argv.indexOf("--count");
    const count = index === -1 ? 60 : Number(process.argv[index + 1]);
    if (!Number.isInteger(count) || count < 1 || count > 2000) throw new Error("--count must be between 1 and 2000");
    return count;
};

// ---------- Seed / clear ----------

const upsertLocations = async () => {
    const communes = [];

    for (const p of LOCATIONS) {
        const province = await Province.findOneAndUpdate(
            { code: p.code },
            { $set: { nameKh: p.nameKh, nameEn: p.nameEn, isActive: true } },
            { upsert: true, returnDocument: 'after' }
        );
        for (const d of p.districts) {
            const district = await District.findOneAndUpdate(
                { provinceId: province._id, code: d.code },
                { $set: { nameKh: d.nameKh, nameEn: d.nameEn, isActive: true } },
                { upsert: true, returnDocument: 'after' }
            );
            for (const [code, nameKh, nameEn] of d.communes) {
                const commune = await Commune.findOneAndUpdate(
                    { districtId: district._id, code },
                    { $set: { provinceId: province._id, nameKh, nameEn, isActive: true } },
                    { upsert: true, returnDocument: 'after' }
                );
                communes.push({ province, district, commune });
            }
        }
    }
    return communes;
};

const upsertSales = async () => {
    await Sale.bulkWrite(
        SALES.map(([code, name, phone]) => ({
            updateOne: { filter: { code }, update: { $set: { name, nameKey: nameKey(name), phone, isActive: true } }, upsert: true }
        }))
    );
    return Sale.find({ code: DEMO });
};

const createSubmission = async ({ index, locations, sales, tmpDir }) => {
    const { province, district, commune } = pick(locations);
    const sale = pick(sales);
    const clientName = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    const submittedAt = randomSubmittedAt();
    const submissionId = new mongoose.Types.ObjectId();

    // 1–3 files: always an ID photo, sometimes a second photo and/or a PDF
    const files = [{ name: `id-card-${index + 1}.png`, buffer: makePng(index), mime: "image/png", ext: "png" }];
    if (crypto.randomInt(3) === 0) files.push({ name: `house-photo-${index + 1}.png`, buffer: makePng(index + 3), mime: "image/png", ext: "png" });
    if (crypto.randomInt(2) === 0) files.push({ name: `លិខិតបញ្ជាក់-${index + 1}.pdf`, buffer: makePdf(`Client document ${index + 1}`), mime: "application/pdf", ext: "pdf" });

    const prepared = [];
    for (const file of files) {
        const filePath = path.join(tmpDir, crypto.randomUUID());
        await fs.writeFile(filePath, file.buffer);
        prepared.push({
            path: filePath,
            originalname: file.name,
            size: file.buffer.length,
            detectedMimeType: file.mime,
            extension: file.ext
        });
    }

    const uploaded = await uploadSubmissionFiles(submissionId, prepared);
    for (const file of uploaded) file.uploadedAt = submittedAt;

    await Submission.create({
        _id: submissionId,
        submissionNo: generateSubmissionNo(submittedAt),
        clientName,
        phone: randomPhone(),
        provinceId: province._id,
        provinceNameKh: province.nameKh,
        provinceNameEn: province.nameEn,
        districtId: district._id,
        districtNameKh: district.nameKh,
        districtNameEn: district.nameEn,
        communeId: commune._id,
        communeNameKh: commune.nameKh,
        communeNameEn: commune.nameEn,
        saleGbId: sale._id,
        saleGbName: sale.name,
        files: uploaded,
        submittedAt,
        createdAt: submittedAt,
        updatedAt: submittedAt
    });
};

/** Every active commune already in the database, with its district and province */
const loadExistingLocations = async () => {
    const [provinces, districts, communes] = await Promise.all([
        Province.find({ isActive: true }).lean(),
        District.find({ isActive: true }).lean(),
        Commune.find({ isActive: true }).lean()
    ]);
    const provinceById = new Map(provinces.map((p) => [String(p._id), p]));
    const districtById = new Map(districts.map((d) => [String(d._id), d]));

    const locations = communes
        .map((commune) => {
            const district = districtById.get(String(commune.districtId));
            const province = district && provinceById.get(String(district.provinceId));
            return province ? { province, district, commune } : null;
        })
        .filter(Boolean);

    if (locations.length === 0) {
        throw new Error("No active locations found. Import locations first (Locations page or npm run import:locations)");
    }
    return locations;
};

const seed = async () => {
    const count = parseCount();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seed-sample-"));

    try {
        const useExisting = process.argv.includes("--use-existing-locations");
        const locations = useExisting ? await loadExistingLocations() : await upsertLocations();
        const sales = await upsertSales();
        console.log(
            useExisting
                ? `Using existing locations: ${new Set(locations.map((l) => String(l.province._id))).size} provinces, ${locations.length} communes`
                : `Demo locations: ${LOCATIONS.length} provinces, ${locations.length} communes`
        );
        console.log(`Demo Sale GB:   ${sales.length}`);

        for (let i = 0; i < count; i++) {
            await createSubmission({ index: i, locations, sales, tmpDir });
            if ((i + 1) % 20 === 0 || i + 1 === count) process.stdout.write(`\rSubmissions:    ${i + 1}/${count}`);
        }
        console.log("\nDone. Run `npm run seed:sample -- --clear` to remove the demo data.");
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
};

/**
 * Removes demo data without touching real data. A real location import can match a
 * demo location by name and attach real districts/communes to it; such demo locations
 * are kept and converted into normal ones (their code becomes the name key, like any
 * location imported without codes) instead of being deleted with their real children.
 */
const clear = async () => {
    const demoSales = await Sale.find({ code: DEMO }).select("_id");
    const demoCommunes = await Commune.find({ code: DEMO }).select("_id");

    // Demo submissions: made with a demo Sale GB, or pointing at a demo commune that is about to go
    const submissions = await Submission.find({
        $or: [{ saleGbId: { $in: demoSales.map((s) => s._id) } }, { communeId: { $in: demoCommunes.map((c) => c._id) } }]
    }).select("files.objectKey");

    const keys = submissions.flatMap((s) => s.files.map((f) => f.objectKey));
    for (let i = 0; i < keys.length; i += 1000) {
        await minioClient.removeObjects(BUCKET, keys.slice(i, i + 1000));
    }
    const subs = await Submission.deleteMany({ _id: { $in: submissions.map((s) => s._id) } });

    const stats = { deleted: { provinces: 0, districts: 0, communes: 0 }, kept: { provinces: 0, districts: 0, communes: 0 } };

    // Leaf level first, then parents, so "has children" reflects what remains
    const levels = [
        { Model: Commune, name: "communes", inUse: (id) => Submission.exists({ communeId: id }) },
        { Model: District, name: "districts", inUse: (id) => Commune.exists({ districtId: id }) },
        { Model: Province, name: "provinces", inUse: (id) => District.exists({ provinceId: id }) }
    ];

    for (const { Model, name, inUse } of levels) {
        for (const doc of await Model.find({ code: DEMO })) {
            if (await inUse(doc._id)) {
                doc.code = nameKey(doc.nameKh);
                await doc.save();
                stats.kept[name]++;
            } else {
                await doc.deleteOne();
                stats.deleted[name]++;
            }
        }
    }

    const salesDeleted = await Sale.deleteMany({ code: DEMO });

    console.log(`Removed ${subs.deletedCount} demo submissions (${keys.length} files) and ${salesDeleted.deletedCount} demo Sale GB`);
    console.log(
        `Removed demo locations: ${stats.deleted.provinces} provinces, ${stats.deleted.districts} districts, ${stats.deleted.communes} communes`
    );
    if (stats.kept.provinces + stats.kept.districts + stats.kept.communes > 0) {
        console.log(
            `Kept as real (your import uses them): ${stats.kept.provinces} provinces, ${stats.kept.districts} districts, ${stats.kept.communes} communes`
        );
        console.log("Re-upload your location file once to restore any real commune whose name matched a demo commune.");
    }
};

try {
    if (config.isProduction) throw new Error("seed:sample is for development only");
    await connectDatabase();
    await ensureBucket();
    await Promise.all([Province.init(), District.init(), Commune.init(), Sale.init(), Submission.init()]);

    if (process.argv.includes("--clear")) await clear();
    else await seed();
} catch (error) {
    console.error("Sample seed failed:", error.message);
    process.exitCode = 1;
} finally {
    await disconnectDatabase().catch(() => {});
}
