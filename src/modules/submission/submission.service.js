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
import { buildStockItems, getStockReport } from "../stock/stock.service.js";
import { StockReport } from "../stock/stockReport.model.js";
import { validateSubmissionFiles } from "../upload/file.validation.js";
import { removeUploadedObjects, uploadSubmissionFiles } from "../upload/upload.service.js";
import { Submission } from "./submission.model.js";
import {
    claimStagedPhotos,
    copyStagedPhotos,
    finishStagedPhotos,
    releaseStagedPhotos
} from "./stagedPhoto.service.js";
import { requestPhotoBackfill } from "./photoDerivatives.service.js";

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
    Submission.findOne({ idempotencyKey }).select("submissionNo +pendingStock").lean();

/**
 * Writes the stock report saved on the outlet (pendingStock), then clears it.
 * The report reuses the outlet's _id, so running this twice (a retry, a restart,
 * two requests at once) still leaves exactly one report.
 */
const completePendingStock = async (submission) => {
    if (!submission?.pendingStock) return;
    await StockReport.updateOne(
        { _id: submission._id },
        { $setOnInsert: { ...submission.pendingStock, outletId: submission._id } },
        { upsert: true }
    );
    await Submission.updateOne({ _id: submission._id }, { $unset: { pendingStock: 1 } });
};

/** A replayed request finishes a stock report left pending by the first attempt */
const replay = async (existing) => {
    await completePendingStock(existing);
    return { submissionNo: existing.submissionNo, replayed: true };
};

const OUTLET_COPY_FIELDS = [
    "provinceId",
    "provinceNameKh",
    "provinceNameEn",
    "districtId",
    "districtNameKh",
    "districtNameEn",
    "communeId",
    "communeNameKh",
    "communeNameEn"
];

/**
 * Copies the outlet's name and location, as saved now, into its stock reports.
 * Read back from the database (not taken from the request), so when two edits
 * of the same outlet overlap, the reports end up matching whichever was saved
 * last. If this fails, the periodic sync below fixes it.
 */
const copyOutletToStockReports = async (outletId) => {
    const outlet = await Submission.findById(outletId)
        .select(["clientName", ...OUTLET_COPY_FIELDS].join(" "))
        .lean();
    if (!outlet) return;
    await StockReport.updateMany(
        { outletId: outlet._id },
        {
            $set: {
                outletName: outlet.clientName,
                ...Object.fromEntries(OUTLET_COPY_FIELDS.map((f) => [f, outlet[f] ?? (f.endsWith("Id") ? undefined : "")]).filter(([, v]) => v !== undefined))
            }
        }
    );
};

/**
 * Brings stock reports back in line with their outlet's current name and
 * location (outlets edited before edits updated their reports). Only reports
 * that differ are written. Run at startup; safe to run more than once.
 */
export const syncStockReportsWithOutlets = async () => {
    const stale = await StockReport.aggregate([
        { $lookup: { from: Submission.collection.name, localField: "outletId", foreignField: "_id", as: "outlet" } },
        { $unwind: "$outlet" },
        {
            $match: {
                $expr: {
                    $or: [
                        { $ne: ["$outletName", "$outlet.clientName"] },
                        // A missing English name counts as empty on both sides
                        ...OUTLET_COPY_FIELDS.map((field) => ({
                            $ne: [{ $ifNull: [`$${field}`, ""] }, { $ifNull: [`$outlet.${field}`, ""] }]
                        }))
                    ]
                }
            }
        },
        { $project: { outlet: { clientName: 1, ...Object.fromEntries(OUTLET_COPY_FIELDS.map((f) => [f, 1])) } } }
    ]).option({ maxTimeMS: config.queryTimeoutMs * 10 });
    if (stale.length === 0) return 0;
    await StockReport.bulkWrite(
        stale.map(({ _id, outlet }) => ({
            updateOne: {
                filter: { _id },
                update: {
                    $set: {
                        outletName: outlet.clientName,
                        ...Object.fromEntries(
                            OUTLET_COPY_FIELDS.map((f) => [f, outlet[f] ?? (f.endsWith("Id") ? undefined : "")]).filter(
                                ([, value]) => value !== undefined
                            )
                        )
                    }
                }
            }
        }))
    );
    return stale.length;
};

/**
 * Finishes stock reports left pending by a stopped process (normally none).
 * Run at startup; safe to run at any time and more than once.
 */
export const completePendingStockReports = async ({ limit = 500 } = {}) => {
    const pending = await Submission.find({ pendingStock: { $exists: true } })
        .select("+pendingStock")
        .limit(limit)
        .lean();
    for (const submission of pending) await completePendingStock(submission);
    return pending.length;
};

const invalidReferences = (errors) => ApiError.validation(errors, "Invalid location or Sale GB selection");

/** Validated location hierarchy as reference + name snapshot fields */
const resolveLocationFields = async ({ provinceId, districtId, districtName, communeId, communeName }) => {
    const { province, district, commune, errors } = await resolveLocationSelection({
        provinceId,
        districtId,
        districtName,
        communeId,
        communeName
    });
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

const gpsFields = (photoId, gps) => ({
    photoId,
    location: { type: "Point", coordinates: [gps.longitude, gps.latitude] },
    accuracy: gps.accuracy,
    capturedAt: gps.capturedAt
});

/**
 * Pairs each site photo (sent with the form, or uploaded earlier and sent as
 * an uploadId) with the GPS entry that has the same photoId, verifies sent
 * photos by content (images only) and attaches the GPS as GeoJSON. Every photo
 * needs GPS and every GPS entry needs its photo.
 */
const verifySitePhotos = async (sitePhotos, gpsEntries = [], stagedPhotos = []) => {
    const gpsById = new Map(gpsEntries.map((entry) => [entry.photoId, entry]));
    const stagedIds = new Set(stagedPhotos.map((photo) => photo.photoId));
    const photoIds = new Set([...sitePhotos.map((photo) => photo.photoId), ...stagedIds]);

    const errors = [
        ...sitePhotos
            .filter((photo) => stagedIds.has(photo.photoId))
            .map((photo) => ({ field: `sitePhotos.${photo.photoId}`, message: "Photo sent twice (file and uploadId)" })),
        ...sitePhotos
            .filter((photo) => !gpsById.has(photo.photoId))
            .map((photo) => ({
                field: `sitePhotos.${photo.photoId}`,
                message: `"${photo.file.originalname}" has no GPS location`
            })),
        ...stagedPhotos
            .filter((photo) => !gpsById.has(photo.photoId))
            .map((photo) => ({ field: `stagedPhotos.${photo.photoId}`, message: "Photo has no GPS location" })),
        ...gpsEntries
            .filter((entry) => !photoIds.has(entry.photoId))
            .map((entry) => ({ field: `sitePhotoMeta.${entry.photoId}`, message: "GPS entry has no matching photo" }))
    ];
    if (errors.length) throw ApiError.validation(errors, "Site photos and GPS do not match");
    const staged = stagedPhotos.map((photo) => ({ ...photo, gps: gpsFields(photo.photoId, gpsById.get(photo.photoId)) }));
    if (sitePhotos.length === 0) return { sent: [], staged };

    let verified;
    try {
        verified = await validateSubmissionFiles(sitePhotos.map((photo) => photo.file));
    } catch (error) {
        // Report problems against the photo, not a position in a list
        if (error instanceof ApiError && Array.isArray(error.errors)) {
            error.errors = error.errors.map((e) => {
                const index = Number(/^files\.(\d+)$/.exec(e.field ?? "")?.[1]);
                return Number.isInteger(index) ? { ...e, field: `sitePhotos.${sitePhotos[index].photoId}` } : e;
            });
        }
        throw error;
    }

    // validateSubmissionFiles keeps the input order when every file is valid
    const sent = verified.map((file, index) => {
        const { photoId } = sitePhotos[index];
        if (!file.detectedMimeType.startsWith("image/")) {
            throw new ApiError(415, "Unsupported file type", [
                { field: `sitePhotos.${photoId}`, message: "A site photo must be a JPG, PNG or WebP image" }
            ]);
        }
        return { ...file, gps: gpsFields(photoId, gpsById.get(photoId)) };
    });
    return { sent, staged };
};

/**
 * Order of operations (compensation strategy):
 *   1. validate files by content   2. validate references + hierarchy + stock
 *   3. upload files to MinIO        4. insert the outlet, with its stock report
 *                                      as pendingStock in the same single write
 *   5. write the stock report (same _id as the outlet), then clear pendingStock
 * If step 3 partially fails, the objects from this request are removed.
 * If step 4 fails, every object uploaded in step 3 is removed.
 * Photos uploaded earlier (stagedPhotos) are reserved for this outlet before
 * step 3 and copied in step 3; whenever the outlet is not created they are
 * released again, so a retry can still use them.
 * If step 5 fails, the outlet and its files are removed (all or nothing). If the
 * process stops during step 5, or that clean-up fails, the pendingStock left on
 * the outlet is finished by a retry with the same Idempotency-Key or at the next
 * start, so an outlet never silently loses its stock.
 * `uploadedBy` is the admin id when an admin creates the submission.
 */
export const createSubmission = async ({ input, files, sitePhotos = [], idempotencyKey, uploadedBy = null }) => {
    if (idempotencyKey) {
        const existing = await findByIdempotencyKey(idempotencyKey);
        if (existing) return replay(existing);
    }

    // Site photos alone satisfy "at least one file"; documents are checked as before
    const { sent: verifiedPhotos, staged: stagedPhotos } = await verifySitePhotos(
        sitePhotos,
        input.sitePhotoMeta,
        input.stagedPhotos
    );
    const photoCount = verifiedPhotos.length + stagedPhotos.length;
    const verifiedDocuments = files?.length || photoCount === 0 ? await validateSubmissionFiles(files) : [];
    if (verifiedDocuments.length + photoCount > config.upload.maxFiles) {
        throw ApiError.validation([
            { field: "files", message: `A maximum of ${config.upload.maxFiles} files is allowed` }
        ]);
    }
    // A new outlet's photos must carry GPS: they come as site photos with a location,
    // never as plain files (only PDFs may be attached without a location)
    const photosWithoutGps = verifiedDocuments.filter((file) => file.detectedMimeType.startsWith("image/"));
    if (photosWithoutGps.length) {
        throw ApiError.validation(
            photosWithoutGps.map((file) => ({
                field: "sitePhotos",
                message: `"${file.originalname}" has no GPS location. Allow location and submit again`
            })),
            "Photos need a GPS location"
        );
    }
    const verifiedFiles = [...verifiedDocuments, ...verifiedPhotos];
    const locationFields = await resolveLocationFields(input);
    const saleFields = await resolveSaleFields(input);
    // The outlet's stock is checked before any file is uploaded
    const stockItems = input.stockItems?.length
        ? await buildStockItems(input.stockItems, { fieldPrefix: "stockItems" })
        : null;

    const submissionId = new mongoose.Types.ObjectId();
    const claimed = await claimStagedPhotos(stagedPhotos, submissionId);
    let uploadedFiles;
    try {
        const uploaded = await uploadSubmissionFiles(submissionId, verifiedFiles, { uploadedBy });
        let copied;
        try {
            copied = await copyStagedPhotos(submissionId, claimed, { uploadedBy });
        } catch (error) {
            await removeUploadedObjects(uploaded.map((file) => file.objectKey));
            throw error;
        }
        // Documents first, then the photos in the order they were added on the form
        const order = new Map((input.sitePhotoMeta ?? []).map((entry, index) => [entry.photoId, index]));
        const rank = (file) => (file.photoId === undefined ? -1 : (order.get(file.photoId) ?? -1));
        uploadedFiles = [...uploaded, ...copied].sort((a, b) => rank(a) - rank(b));
    } catch (error) {
        await releaseStagedPhotos(submissionId);
        throw error;
    }

    const submittedAt = new Date();
    const document = {
        _id: submissionId,
        clientName: input.clientName,
        phone: input.phone,
        ...locationFields,
        ...saleFields,
        files: uploadedFiles,
        idempotencyKey: idempotencyKey || undefined,
        submittedAt,
        // Saved with the outlet in one write; turned into the stock report below
        pendingStock: stockItems
            ? {
                  outletName: input.clientName,
                  provinceId: locationFields.provinceId,
                  provinceNameKh: locationFields.provinceNameKh,
                  provinceNameEn: locationFields.provinceNameEn,
                  districtId: locationFields.districtId,
                  districtNameKh: locationFields.districtNameKh,
                  districtNameEn: locationFields.districtNameEn,
                  communeId: locationFields.communeId,
                  communeNameKh: locationFields.communeNameKh,
                  communeNameEn: locationFields.communeNameEn,
                  items: stockItems,
                  reportedAt: submittedAt,
                  submittedBy: uploadedBy
              }
            : undefined
    };

    try {
        for (let attempt = 1; ; attempt++) {
            document.submissionNo = generateSubmissionNo(submittedAt);
            try {
                await Submission.create(document);
                break;
            } catch (error) {
                if (duplicateKeyField(error) === "submissionNo" && attempt < MAX_NUMBER_ATTEMPTS) continue;
                throw error;
            }
        }
    } catch (error) {
        await removeUploadedObjects(uploadedFiles.map((file) => file.objectKey));
        await releaseStagedPhotos(submissionId);

        // A concurrent request with the same Idempotency-Key won the race
        if (duplicateKeyField(error) === "idempotencyKey") {
            const existing = await findByIdempotencyKey(idempotencyKey);
            if (existing) return replay(existing);
        }

        throw error;
    }

    if (document.pendingStock) {
        try {
            await completePendingStock(document);
        } catch (error) {
            // All or nothing: undo the outlet and its files. If this clean-up itself fails,
            // pendingStock stays on the outlet and is finished by a retry or at the next start.
            try {
                await Submission.deleteOne({ _id: submissionId, pendingStock: { $exists: true } });
                await StockReport.deleteOne({ _id: submissionId });
                await removeUploadedObjects(uploadedFiles.map((file) => file.objectKey));
                await releaseStagedPhotos(submissionId);
            } catch (cleanupError) {
                console.error(`Outlet ${submissionId}: stock report pending, clean-up failed:`, cleanupError.message);
            }
            throw error;
        }
    }

    await finishStagedPhotos(submissionId);
    // Export preview and map thumbnail, made in the background
    requestPhotoBackfill();
    return { submissionNo: document.submissionNo, replayed: false };
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

    // The outlet's stock reports keep their own copy of its name and location; keep them in step
    if ($set.clientName !== undefined || $set.provinceId) await copyOutletToStockReports(id);

    return getSubmissionDetails(id);
};

/**
 * Admin: sets an outlet's stock. Replaces the quantities of its stock report, or
 * adds the report again when it was deleted (dated like the outlet, so the
 * dashboards count it in the same period). Products and quantities are checked
 * like on the outlet form; the name and location come from the outlet.
 */
export const setOutletStock = async (id, inputItems, { updatedBy }) => {
    const outlet = await Submission.findById(id)
        .select(["clientName", "submittedAt", ...OUTLET_COPY_FIELDS].join(" "))
        .lean();
    if (!outlet) throw ApiError.notFound("Outlet not found");
    const items = await buildStockItems(inputItems, { fieldPrefix: "stockItems" });

    const $set = {
        items,
        updatedBy,
        outletName: outlet.clientName,
        ...Object.fromEntries(
            OUTLET_COPY_FIELDS.map((f) => [f, outlet[f] ?? (f.endsWith("Id") ? undefined : "")]).filter(([, v]) => v !== undefined)
        )
    };
    // Its latest report; one added from the form or here has the outlet's own _id
    const existing = await StockReport.findOne({ outletId: outlet._id }).sort({ reportedAt: -1 }).select("_id").lean();
    const reportId = existing?._id ?? outlet._id;
    const write = () =>
        StockReport.updateOne(
            { _id: reportId },
            { $set, $setOnInsert: { outletId: outlet._id, reportedAt: outlet.submittedAt, submittedBy: updatedBy } },
            { upsert: true, runValidators: true }
        );
    try {
        await write();
    } catch (error) {
        // Two saves adding it at the same moment: the other one created it, so update it
        if (duplicateKeyField(error) !== "_id") throw error;
        await write();
    }
    return getStockReport(reportId.toString());
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

    requestPhotoBackfill();
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

    await removeUploadedObjects([file.objectKey, file.thumbnailKey, file.previewKey].filter(Boolean));
    return getSubmissionDetails(id);
};

/** Deletes the submission, then its stored files (a failed file cleanup is logged, not fatal) */
/**
 * Stock reports go first, then the outlet, then its files. If the process stops
 * part-way, no stock report is left pointing at a deleted outlet; deleting again
 * finishes the job.
 */
export const deleteSubmission = async (id) => {
    const existing = await Submission.exists({ _id: id });
    if (!existing) throw ApiError.notFound("Submission not found");
    await StockReport.deleteMany({ outletId: existing._id });
    const doc = await Submission.findOneAndDelete({ _id: existing._id })
        .select("files.objectKey files.thumbnailKey files.previewKey")
        .lean();
    // Deleted by a concurrent request in the meantime
    if (!doc) throw ApiError.notFound("Submission not found");
    await removeUploadedObjects(
        doc.files.flatMap((file) => [file.objectKey, file.thumbnailKey, file.previewKey].filter(Boolean))
    );
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
    // At least one site photo with GPS, i.e. the outlet can be shown on the map
    hasGps: Boolean(doc.hasGps ?? doc.files?.some((file) => file.location?.type === "Point")),
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
    fileCount: { $size: "$files" },
    // "$files.location.type" lists the location type of every file that has one
    hasGps: { $in: ["Point", { $ifNull: ["$files.location.type", []] }] }
};

export const listSubmissions = async (query) => {
    const filter = buildSubmissionFilter(query);
    const { page, limit, skip } = getPagination(query);

    const [docs, total] = await Promise.all([
        Submission.find(filter, LIST_PROJECTION)
            .sort(buildSort(query))
            .skip(skip)
            .limit(limit)
            .maxTimeMS(config.queryTimeoutMs)
            .lean(),
        Submission.countDocuments(filter).maxTimeMS(config.queryTimeoutMs)
    ]);

    return {
        data: docs.map(toListItem),
        pagination: buildPagination({ page, limit, total })
    };
};

/** GeoJSON [lng, lat] back to plain latitude/longitude, or null when the file has no valid GPS */
export const toGps = (file) => {
    const [longitude, latitude] = file.location?.coordinates ?? [];
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return {
        photoId: file.photoId ?? null,
        latitude,
        longitude,
        accuracy: file.accuracy ?? null,
        capturedAt: file.capturedAt ?? null
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
            urlExpiresAt,
            // Site photos only; null for documents and older submissions
            gps: toGps(file)
        }))
    );

    return {
        ...toListItem(doc),
        files,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
};
