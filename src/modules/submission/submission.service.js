import crypto from "node:crypto";
import mongoose from "mongoose";
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

/**
 * Order of operations (compensation strategy):
 *   1. validate files by content   2. validate references + hierarchy
 *   3. upload files to MinIO        4. insert the MongoDB document
 * If step 3 partially fails, the objects from this request are removed.
 * If step 4 fails, every object uploaded in step 3 is removed.
 */
export const createSubmission = async ({ input, files, idempotencyKey }) => {
    if (idempotencyKey) {
        const existing = await findByIdempotencyKey(idempotencyKey);
        if (existing) return { submissionNo: existing.submissionNo, replayed: true };
    }

    const verifiedFiles = await validateSubmissionFiles(files);

    const [locations, saleSelection] = await Promise.all([
        resolveLocationSelection(input),
        resolveSaleSelection(input.saleGbId)
    ]);

    const referenceErrors = [...locations.errors, ...saleSelection.errors];
    if (referenceErrors.length > 0) {
        throw ApiError.validation(referenceErrors, "Invalid location or Sale GB selection");
    }

    const { province, district, commune } = locations;
    const { sale } = saleSelection;

    const submissionId = new mongoose.Types.ObjectId();
    const uploadedFiles = await uploadSubmissionFiles(submissionId, verifiedFiles);

    const submittedAt = new Date();
    const document = {
        _id: submissionId,
        clientName: input.clientName,
        phone: input.phone,

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
    saleGb: { id: doc.saleGbId.toString(), name: doc.saleGbName },
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
