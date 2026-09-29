import ExcelJS from "exceljs";
import mongoose from "mongoose";
import config from "../../config/env.js";
import { buildPagination, escapeRegex } from "../../utils/pagination.js";
import ApiError from "../../utils/ApiError.js";
import { nameKey, parseWorkbook, syncLocations } from "./location.import.js";
import { Submission } from "../submission/submission.model.js";
import { Province } from "./province.model.js";
import { District } from "./district.model.js";
import { Commune } from "./commune.model.js";

const PUBLIC_FIELDS = "nameKh nameEn code";
const SORT = { code: 1, nameEn: 1, _id: 1 };

// Lightweight shape for searchable comboboxes
const toOption = (doc) => ({
    id: doc._id.toString(),
    nameKh: doc.nameKh,
    nameEn: doc.nameEn,
    code: doc.code
});

export const listProvinces = async () => {
    const docs = await Province.find({ isActive: true }).select(PUBLIC_FIELDS).sort(SORT).lean();
    return docs.map(toOption);
};

export const listDistricts = async (provinceId) => {
    const docs = await District.find({ provinceId, isActive: true }).select(PUBLIC_FIELDS).sort(SORT).lean();
    return docs.map(toOption);
};

export const listCommunes = async (districtId, provinceId) => {
    const filter = { districtId, isActive: true, ...(provinceId ? { provinceId } : {}) };
    const docs = await Commune.find(filter).select(PUBLIC_FIELDS).sort(SORT).lean();
    return docs.map(toOption);
};

/**
 * Loads the selected locations and verifies the hierarchy.
 * Returns field-level errors instead of throwing so callers can combine them.
 */
export const resolveLocationSelection = async ({ provinceId, districtId, communeId }) => {
    const [province, district, commune] = await Promise.all([
        Province.findById(provinceId).lean(),
        District.findById(districtId).lean(),
        Commune.findById(communeId).lean()
    ]);

    const errors = [];

    if (!province) errors.push({ field: "provinceId", message: "Province not found" });
    else if (!province.isActive) errors.push({ field: "provinceId", message: "Province is not available" });

    if (!district) errors.push({ field: "districtId", message: "District not found" });
    else if (!district.isActive) errors.push({ field: "districtId", message: "District is not available" });
    else if (province && !district.provinceId.equals(province._id)) {
        errors.push({ field: "districtId", message: "District does not belong to the selected province" });
    }

    if (!commune) errors.push({ field: "communeId", message: "Commune not found" });
    else if (!commune.isActive) errors.push({ field: "communeId", message: "Commune is not available" });
    else if (district && !commune.districtId.equals(district._id)) {
        errors.push({ field: "communeId", message: "Commune does not belong to the selected district" });
    }

    return { province, district, commune, errors };
};

// ---------- Admin: summary, import, template ----------

const MAX_REPORT_ROWS = 200;

export const getLocationSummary = async () => {
    const count = async (Model) => {
        const [total, active] = await Promise.all([Model.countDocuments(), Model.countDocuments({ isActive: true })]);
        return { total, active };
    };
    const [provinces, districts, communes] = await Promise.all([count(Province), count(District), count(Commune)]);
    return { provinces, districts, communes };
};

/**
 * Parses an uploaded workbook and compares it with the database.
 * With dryRun (the "Check file" step) nothing is written.
 */
export const importLocations = async (buffer, { dryRun, fileName }) => {
    let parsed;
    try {
        parsed = await parseWorkbook(buffer);
    } catch {
        throw ApiError.badRequest("The Excel file could not be read. Save it as .xlsx and try again");
    }

    if (parsed.sheetsUsed.length === 0) {
        const seen = parsed.sheetsSkipped.flatMap((s) => s.headers).slice(0, 10);
        throw ApiError.validation(
            [
                {
                    field: "file",
                    message:
                        "No header row found. Use the columns ខេត្ត/ក្រុង, ខណ្ឌ/ស្រុក and ឃុំ/ភូមិ" +
                        (seen.length ? `. Headers found: ${seen.join(", ")}` : "")
                }
            ],
            "Unrecognised file layout"
        );
    }

    const result = await syncLocations(parsed, { dryRun });
    const limited = (rows) => ({ total: rows.length, items: rows.slice(0, MAX_REPORT_ROWS) });

    return {
        dryRun,
        fileName,
        sheets: parsed.sheetsUsed.map(({ name, headerRow }) => ({ name, headerRow })),
        skippedSheets: parsed.sheetsSkipped.map(({ name }) => name),
        rows: {
            read: parsed.stats.rowsRead,
            blank: parsed.stats.rowsSkippedBlank,
            inheritedParent: parsed.stats.rowsInherited
        },
        inFile: {
            provinces: parsed.provinces.size,
            districts: parsed.districts.size,
            communes: parsed.communes.size
        },
        result,
        duplicates: limited(parsed.duplicates),
        invalid: limited(parsed.invalid),
        warnings: limited(parsed.warnings)
    };
};

export const TEMPLATE_HEADERS = ["ខេត្ត/ក្រុង", "ខណ្ឌ/ស្រុក", "ឃុំ/ភូមិ"];

export const writeTemplate = async (outputStream) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Locations", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = TEMPLATE_HEADERS.map((header) => ({ header, width: 28 }));
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: "A1", to: "C1" };
    await workbook.xlsx.write(outputStream);
};

/**
 * Admin table. Starts from provinces so a province without districts, or a district
 * without communes, still gets a row (with district/commune null) and can be managed.
 * Rows of the same province, then district, are adjacent.
 */
export const listLocationRows = async ({ search, provinceId, page, limit }) => {
    const ref = (path) => ({
        $cond: [
            { $ifNull: [`$${path}._id`, false] },
            {
                id: { $toString: `$${path}._id` },
                nameKh: `$${path}.nameKh`,
                nameEn: `$${path}.nameEn`,
                isActive: `$${path}.isActive`
            },
            null
        ]
    });

    const pipeline = [];
    if (provinceId) pipeline.push({ $match: { _id: new mongoose.Types.ObjectId(provinceId) } });

    pipeline.push(
        { $lookup: { from: "districts", localField: "_id", foreignField: "provinceId", as: "district" } },
        { $unwind: { path: "$district", preserveNullAndEmptyArrays: true } },
        { $lookup: { from: "communes", localField: "district._id", foreignField: "districtId", as: "commune" } },
        { $unwind: { path: "$commune", preserveNullAndEmptyArrays: true } }
    );

    if (search) {
        const pattern = new RegExp(escapeRegex(search.normalize("NFC")), "i");
        pipeline.push({
            $match: {
                $or: ["nameKh", "nameEn", "district.nameKh", "district.nameEn", "commune.nameKh", "commune.nameEn"].map(
                    (field) => ({ [field]: pattern })
                )
            }
        });
    }

    pipeline.push(
        { $sort: { code: 1, "district.code": 1, "commune.code": 1, _id: 1 } },
        {
            $facet: {
                rows: [
                    { $skip: (page - 1) * limit },
                    { $limit: limit },
                    {
                        $project: {
                            _id: 0,
                            id: {
                                $toString: { $ifNull: ["$commune._id", { $ifNull: ["$district._id", "$_id"] }] }
                            },
                            province: {
                                id: { $toString: "$_id" },
                                nameKh: "$nameKh",
                                nameEn: "$nameEn",
                                isActive: "$isActive"
                            },
                            district: ref("district"),
                            commune: ref("commune")
                        }
                    }
                ],
                total: [{ $count: "count" }]
            }
        }
    );

    const [result] = await Province.aggregate(pipeline).option({ maxTimeMS: config.queryTimeoutMs });
    return {
        data: result.rows,
        pagination: buildPagination({ page, limit, total: result.total[0]?.count ?? 0 })
    };
};

// ---------- Admin CRUD ----------

const LEVELS = {
    provinces: { Model: Province, label: "Province", parent: null },
    districts: { Model: District, label: "District", parent: { field: "provinceId", Model: Province, label: "province" } },
    communes: { Model: Commune, label: "Commune", parent: { field: "districtId", Model: District, label: "district" } }
};

const CHILDREN = {
    provinces: { Model: District, field: "provinceId", label: "districts" },
    districts: { Model: Commune, field: "districtId", label: "communes" }
};

const SUBMISSION_FIELD = { provinces: "provinceId", districts: "districtId", communes: "communeId" };

const toAdminJson = (doc) => ({
    id: doc._id.toString(),
    nameKh: doc.nameKh,
    nameEn: doc.nameEn ?? "",
    code: doc.code,
    isActive: doc.isActive,
    ...(doc.provinceId ? { provinceId: doc.provinceId.toString() } : {}),
    ...(doc.districtId ? { districtId: doc.districtId.toString() } : {})
});

/** Same uniqueness rule as the Excel import: one name per parent, compared by name key */
const assertUniqueName = async (level, scope, nameKh, excludeId) => {
    const { Model, label, parent } = LEVELS[level];
    const siblings = await Model.find({ ...scope, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
        .select("nameKh")
        .lean();
    const key = nameKey(nameKh);
    const clash = siblings.find((sibling) => nameKey(sibling.nameKh) === key);
    if (clash) {
        throw ApiError.conflict(`${label} "${clash.nameKh}" already exists${parent ? ` in this ${parent.label}` : ""}`, [
            { field: "nameKh", message: `"${clash.nameKh}" already exists${parent ? ` in this ${parent.label}` : ""}` }
        ]);
    }
};

export const createLocation = async (level, { parentId, nameKh, nameEn = "" }) => {
    const { Model, parent } = LEVELS[level];
    const doc = { nameKh, nameEn, code: nameKey(nameKh), isActive: true };

    if (parent) {
        const parentDoc = await parent.Model.findById(parentId).lean();
        if (!parentDoc) throw ApiError.validation([{ field: "parentId", message: `Selected ${parent.label} not found` }]);
        doc[parent.field] = parentDoc._id;
        if (level === "communes") doc.provinceId = parentDoc.provinceId;
    }

    await assertUniqueName(level, parent ? { [parent.field]: doc[parent.field] } : {}, nameKh);
    const created = await Model.create(doc);

    // The parent may have been deleted while this was being added: never leave an orphan
    if (parent && !(await parent.Model.exists({ _id: doc[parent.field] }))) {
        await Model.deleteOne({ _id: created._id });
        throw ApiError.validation([{ field: "parentId", message: `Selected ${parent.label} not found` }]);
    }
    return toAdminJson(created);
};

export const updateLocation = async (level, id, changes) => {
    const { Model, label, parent } = LEVELS[level];
    const doc = await Model.findById(id);
    if (!doc) throw ApiError.notFound(`${label} not found`);

    if (changes.nameKh !== undefined && nameKey(changes.nameKh) !== nameKey(doc.nameKh)) {
        await assertUniqueName(level, parent ? { [parent.field]: doc[parent.field] } : {}, changes.nameKh, doc._id);
    }

    // The code is the import key, so it is kept on rename; re-imports still match by name
    Object.assign(doc, changes);
    await doc.save();
    return toAdminJson(doc);
};

/** Throws 409 when the location still has children or submissions */
const assertUnused = async (level, doc) => {
    const { label } = LEVELS[level];
    const children = CHILDREN[level];
    if (children) {
        const count = await children.Model.countDocuments({ [children.field]: doc._id });
        if (count > 0) {
            throw ApiError.conflict(
                `${label} "${doc.nameKh}" still has ${count} ${children.label}. Delete them first, or deactivate it instead`
            );
        }
    }

    const used = await Submission.countDocuments({ [SUBMISSION_FIELD[level]]: doc._id });
    if (used > 0) {
        throw ApiError.conflict(
            `${label} "${doc.nameKh}" is used by ${used} submission${used === 1 ? "" : "s"}. Deactivate it instead of deleting`
        );
    }
};

/**
 * Deletes a location nobody uses, without transactions:
 *   1. deactivate it, so new submissions stop choosing it
 *   2. check it has no children and no submissions (else put isActive back, 409)
 *   3. delete it, then check again; anything added in between (a child, or a
 *      submission already in progress) puts the location back and returns 409
 * A child added concurrently is also removed by createLocation when its parent
 * is gone, so either way no record is left pointing at a missing location.
 */
export const deleteLocation = async (level, id) => {
    const { Model, label } = LEVELS[level];
    const doc = await Model.findById(id).lean();
    if (!doc) throw ApiError.notFound(`${label} not found`);

    await Model.updateOne({ _id: doc._id }, { $set: { isActive: false } });
    try {
        await assertUnused(level, doc);
    } catch (error) {
        await Model.updateOne({ _id: doc._id }, { $set: { isActive: doc.isActive } });
        throw error;
    }

    const deleted = await Model.deleteOne({ _id: doc._id });
    if (deleted.deletedCount === 0) throw ApiError.notFound(`${label} not found`);

    try {
        await assertUnused(level, doc);
    } catch (error) {
        await Model.collection.insertOne(doc);
        throw error;
    }
};
