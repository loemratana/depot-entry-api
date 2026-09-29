import ApiError from "../../utils/ApiError.js";
import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { IDEMPOTENCY_KEY_PATTERN } from "./submission.validation.js";
import * as submissionService from "./submission.service.js";

const readIdempotencyKey = (req) => {
    const key = req.get("idempotency-key");
    if (key === undefined) return undefined;

    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
        throw ApiError.validation([
            {
                field: "Idempotency-Key",
                message: "Must be 8–128 characters of letters, numbers, '.', '_', ':' or '-'"
            }
        ]);
    }
    return key;
};

export const createSubmission = asyncHandler(async (req, res) => {
    const idempotencyKey = readIdempotencyKey(req);

    const { submissionNo, replayed } = await submissionService.createSubmission({
        input: req.validated.body,
        files: req.files,
        sitePhotos: req.sitePhotos,
        idempotencyKey
    });

    if (replayed) res.set("Idempotent-Replayed", "true");

    sendSuccess(res, {
        statusCode: replayed ? 200 : 201,
        message: "Submission received successfully",
        data: { submissionNo }
    });
});

export const listSubmissions = asyncHandler(async (req, res) => {
    const { data, pagination } = await submissionService.listSubmissions(req.validated.query);
    sendSuccess(res, { data, pagination });
});

export const getSubmission = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const data = await submissionService.getSubmissionDetails(req.validated.params.id);
    sendSuccess(res, { data });
});

// ---------- Admin CRUD ----------

export const adminCreateSubmission = asyncHandler(async (req, res) => {
    const { submissionNo } = await submissionService.createSubmission({
        input: req.validated.body,
        files: req.files,
        uploadedBy: req.admin._id
    });
    sendSuccess(res, { statusCode: 201, message: "Client added", data: { submissionNo } });
});

export const updateSubmission = asyncHandler(async (req, res) => {
    const data = await submissionService.updateSubmission(req.validated.params.id, req.validated.body);
    sendSuccess(res, { message: "Client updated", data });
});

export const deleteSubmission = asyncHandler(async (req, res) => {
    await submissionService.deleteSubmission(req.validated.params.id);
    sendSuccess(res, { message: "Client deleted" });
});

export const addFiles = asyncHandler(async (req, res) => {
    const data = await submissionService.addSubmissionFiles(req.validated.params.id, req.files, {
        uploadedBy: req.admin._id
    });
    sendSuccess(res, { statusCode: 201, message: "Files added", data });
});

export const removeFile = asyncHandler(async (req, res) => {
    const { id, fileId } = req.validated.params;
    const data = await submissionService.removeSubmissionFile(id, fileId);
    sendSuccess(res, { message: "File removed", data });
});
