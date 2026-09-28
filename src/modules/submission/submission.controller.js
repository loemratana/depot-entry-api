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
