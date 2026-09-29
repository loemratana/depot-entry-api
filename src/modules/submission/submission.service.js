import crypto from "node:crypto";
import mongoose from "mongoose";
import config from "../../config/env.js";
import { getPresignedUrl, URL_EXPIRY_SECONDS } from "../../config/minio.js";
import ApiError from "../../utils/ApiError.js";
import { businessDate } from "../../utils/date.js";
import { buildPagination, escapeRegex, getPagination } from "../../utils/pagination.js";
import { normalizePhone } from "../../utils/validators.js";
import { resolveLocationSelection } from "../location/location.service.js";
import { resolveSaleSelection } from "../sale/sale.service.js";
import { validateSubmissionFiles } from "../upload/file.validation.js";
import { removeUploadedObjects, uploadSubmissionFiles } from "../upload/upload.service.js";
import { Submission } from "./submission.model.js";

// Crockford base32: no I, L, O, U, so numbers read back over the phone are unambiguous
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_NUMBER_ATTEMPTS = 5;

/**
 * CL-YYYYMMDD-XXXXXXXX with 40 bits of cryptographic randomness per day.
 * Collisions are astronomically unlikely and are still caught by the unique index and retried.
 */
export const generateSubmissionNo = (date = new Date()) => {
    const bytes = crypto.randomBytes(8);
    const suffix = Array.from(bytes, (byte) => ALPHABET[byte % 32]).join("");
    return `CL-${businessDate(date).replaceAll("-", "")}-${suffix}`;
};

const duplicateKeyField = (error) =>
    error?.code === 11000 ? Object.keys(error.keyPattern || error.keyValue || {})[0] : null;

const findByIdempotencyKey = (idempotencyKey) =>
    Submission.findOne({ idempotencyKey }).select("submissionNo").lean();

const invalidReferences = (errors) => ApiError.validation(errors, "Invalid location or Sale GB selection");

/** Validated location hierarchy as reference + name snapshot fields */
const resolveLocationFields = async ({ provinceId, districtId, communeId }) => {
    const { province, district, commune, errors } = await resolveLocationSelection({ provinceId, districtId, communeId });
    if (errors.length) throw invalidReferences(errors);
    return {
        provinceId: province._id,
        provinceNameKh: province.nameKh,
        provinceNameEn: province.nameEn,
        districtId: district._id,
        districtNameKh: district.nameKh,
        districtNameEn: district.nameEn,
        communeId: commune._id,
        communeNameKh: commune.nameKh,
        communeNameEn: commune.nameEn
    };
};

/**
 * Sale GB by id or typed name as reference + name snapshot. Called after the
 * location check, because a typed new name adds it to the Sale GB list.
 */
const resolveSaleFields = async ({ saleGbId, saleGbName }) => {
    if (!saleGbId && !saleGbName) return { saleGbId: null, saleGbName: null };
    const { sale, errors } = await resolveSaleSelection({ saleGbId, saleGbName });
    if (errors.length) throw invalidReferences(errors);
    return { saleGbId: sale._id, saleGbName: sale.name };
};

/**
 * Order of operations (compensation strategy):
 *   1. validate files by content   2. validate references + hierarchy
 *   3. upload files to MinIO        4. insert the MongoDB document
 * If step 3 partially fails, the objects from this request are removed.
 * If step 4 fails, every object uploaded in step 3 is removed.
 * `uploadedBy` is the admin id when an admin creates the submission.
 */
export const createSubmission = async ({ input, files, idempotencyKey, uploadedBy = null }) => {
    if (idempotencyKey) {
        const existing = await findByIdempotencyKey(idempotencyKey);
        if (existing) return { submissionNo: existing.submissionNo, replayed: true };
    }

    const verifiedFiles = await validateSubmissionFiles(files);
    const locationFields = await resolveLocationFields(input);
    const saleFields = await resolveSaleFields(input);

    const submissionId = new mongoose.Types.ObjectId();
    const uploadedFiles = await uploadSubmissionFiles(submissionId, verifiedFiles, { uploadedBy });

    const submittedAt = new Date();
    const document = {
        _id: submissionId,
        clientName: input.clientName,
        phone: input.phone,
        ...locationFields,
        ...saleFields,
        files: uploadedFiles,
        idempotencyKey: idempotencyKey || undefined,
        submittedAt
    };

    try {
        for (let attempt = 1; ; attempt++) {
            document.submissionNo = generateSubmissionNo(submittedAt);
            try {
                await Submission.create(document);
                return { submissionNo: document.submissionNo, replayed: false };
            } catch (error) {
                if (duplicateKeyField(error) === "submissionNo" && attempt < MAX_NUMBER_ATTEMPTS) continue;
                throw error;
            }
        }
    } catch (error) {
        await removeUploadedObjects(uploadedFiles.map((file) => file.objectKey));

        // A concurrent request with the same Idempotency-Key won the race
        if (duplicateKeyField(error) === "idempotencyKey") {
            const existing = await findByIdempotencyKey(idempotencyKey);
            if (existing) return { submissionNo: existing.submissionNo, replayed: true };
        }

        throw error;
    }
};

// ---------- Admin edit / delete ----------

const findSubmissionOr404 = async (id) => {
    const doc = await Submission.findById(id).select("_id files").lean();
    if (!doc) throw ApiError.notFound("Submission not found");
    return doc;
};

/** Updates client fields; a changed location or Sale GB refreshes the name snapshots too */
export const updateSubmission = async (id, changes) => {
    await findSubmissionOr404(id);

    const $set = {};
    if (changes.clientName !== undefined) $set.clientName = changes.clientName;
    if (changes.phone !== undefined) $set.phone = changes.phone;
    if (changes.provinceId) Object.assign($set, await resolveLocationFields(changes));
    if (changes.saleGbId || changes.saleGbName) Object.assign($set, await resolveSaleFields(changes));

    await Submission.updateOne({ _id: id }, { $set });
    return getSubmissionDetails(id);
};

/** Adds files uploaded by an admin, each with its own upload time; total stays within the limit */
export const addSubmissionFiles = async (id, files, { uploadedBy }) => {
    const doc = await findSubmissionOr404(id);
    const verifiedFiles = await validateSubmissionFiles(files);

    const maxFiles = config.upload.maxFiles;
    if (doc.files.length + verifiedFiles.length > maxFiles) {
        throw ApiError.validation([
            {
                field: "files",
                message: `A submission can have at most ${maxFiles} files; it already has ${doc.files.length}`
            }
        ]);
    }

    const uploaded = await uploadSubmissionFiles(id, verifiedFiles, { uploadedBy });

    // Conditional push: a concurrent add cannot take the total over the limit
    const result = await Submission.updateOne(
        { _id: id, [`files.${maxFiles - uploaded.length}`]: { $exists: false } },
        { $push: { files: { $each: uploaded } } }
    );
    if (result.modifiedCount === 0) {
        await removeUploadedObjects(uploaded.map((file) => file.objectKey));
        throw ApiError.conflict(`A submission can have at most ${maxFiles} files`);
    }

    return getSubmissionDetails(id);
};

/** Removes one file; the last file cannot be removed (a submission needs at least one) */
export const removeSubmissionFile = async (id, fileId) => {
    const doc = await findSubmissionOr404(id);
    const file = doc.files.find((f) => f._id.equals(fileId));
    if (!file) throw ApiError.notFound("File not found");

    // "files.1" exists = at least two files, checked atomically with the pull
    const result = await Submission.updateOne(
        { _id: id, "files._id": file._id, "files.1": { $exists: true } },
        { $pull: { files: { _id: file._id } } }
    );
    if (result.modifiedCount === 0) {
        throw ApiError.conflict("A submission must keep at least one file. Add another file before removing this one");
    }

    await removeUploadedObjects([file.objectKey]);
    return getSubmissionDetails(id);
};

/** Deletes the submission, then its stored files (a failed file cleanup is logged, not fatal) */
export const deleteSubmission = async (id) => {
    const doc = await Submission.findByIdAndDelete(id).select("files.objectKey").lean();
    if (!doc) throw ApiError.notFound("Submission not found");
    await removeUploadedObjects(doc.files.map((file) => file.objectKey));
};

export const buildSubmissionFilter = ({ search, provinceId, districtId, communeId, saleGbId, dateFrom, dateTo }) => {
    const filter = {};

    if (provinceId) filter.provinceId = new mongoose.Types.ObjectId(provinceId);
    if (districtId) filter.districtId = new mongoose.Types.ObjectId(districtId);
    if (communeId) filter.communeId = new mongoose.Types.ObjectId(communeId);
    if (saleGbId) filter.saleGbId = new mongoose.Types.ObjectId(saleGbId);

    if (dateFrom || dateTo) {
        filter.submittedAt = {};
        if (dateFrom) filter.submittedAt.$gte = dateFrom;
        if (dateTo) filter.submittedAt.$lte = dateTo;
    }

    if (search) {
        const text = search.normalize("NFC");
        const or = [
            { clientName: new RegExp(escapeRegex(text), "i") },
            { submissionNo: new RegExp(escapeRegex(text.toUpperCase())) }
        ];

        const digits = normalizePhone(text).replace(/\D/g, "");
        if (digits.length >= 3) {
            or.push({ phone: new RegExp(escapeRegex(digits)) });
        }

        filter.$or = or;
    }

    return filter;
};

export const buildSort = ({ sortBy = "submittedAt", sortOrder = "desc" }) => {
    const direction = sortOrder === "asc" ? 1 : -1;
    // _id tiebreaker keeps page boundaries stable
    return { [sortBy]: direction, _id: direction };
};

const toListItem = (doc) => ({
    id: doc._id.toString(),
    submissionNo: doc.submissionNo,
    clientName: doc.clientName,
    phone: doc.phone,
    province: { id: doc.provinceId.toString(), nameKh: doc.provinceNameKh, nameEn: doc.provinceNameEn },
    district: { id: doc.districtId.toString(), nameKh: doc.districtNameKh, nameEn: doc.districtNameEn },
    commune: { id: doc.communeId.toString(), nameKh: doc.communeNameKh, nameEn: doc.communeNameEn },
    saleGb: doc.saleGbId ? { id: doc.saleGbId.toString(), name: doc.saleGbName } : null,
    fileCount: doc.fileCount ?? doc.files?.length ?? 0,
    submittedAt: doc.submittedAt
});

const LIST_PROJECTION = {
    submissionNo: 1,
    clientName: 1,
    phone: 1,
    provinceId: 1,
    provinceNameKh: 1,
    provinceNameEn: 1,
    districtId: 1,
    districtNameKh: 1,
    districtNameEn: 1,
    communeId: 1,
    communeNameKh: 1,
    communeNameEn: 1,
    saleGbId: 1,
    saleGbName: 1,
    submittedAt: 1,
    fileCount: { $size: "$files" }
};

export const listSubmissions = async (query) => {
    const filter = buildSubmissionFilter(query);
    const { page, limit, skip } = getPagination(query);

    const [docs, total] = await Promise.all([
        Submission.find(filter, LIST_PROJECTION).sort(buildSort(query)).skip(skip).limit(limit).lean(),
        Submission.countDocuments(filter)
    ]);

    return {
        data: docs.map(toListItem),
        pagination: buildPagination({ page, limit, total })
    };
};

export const getSubmissionDetails = async (id) => {
    const doc = await Submission.findById(id).lean();
    if (!doc) throw ApiError.notFound("Submission not found");

    const urlExpiresAt = new Date(Date.now() + URL_EXPIRY_SECONDS * 1000).toISOString();

    // Short-lived URLs are generated per request and never stored
    const files = await Promise.all(
        doc.files.map(async (file) => ({
            id: file._id.toString(),
            originalName: file.originalName,
            mimeType: file.mimeType,
            size: file.size,
            uploadedAt: file.uploadedAt,
            // null for files the client sent from the public form
            uploadedByAdmin: Boolean(file.uploadedBy),
            url: await getPresignedUrl(file.objectKey, file.originalName),
            urlExpiresAt
        }))
    );

    return {
        ...toListItem(doc),
        files,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
};
