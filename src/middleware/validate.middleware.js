import ApiError from "../utils/ApiError.js";

export const formatZodIssues = (issues) =>
    issues.map((issue) => ({
        field: issue.path.join(".") || undefined,
        message: issue.message
    }));

/**
 * Validates req.params / req.query / req.body against Zod schemas.
 * Parsed (coerced, trimmed) values are exposed on req.validated because
 * req.query is read-only in Express 5.
 */
const validate = (schemas) => async (req, res, next) => {
    const errors = [];
    req.validated = req.validated || {};

    for (const key of ["params", "query", "body"]) {
        const schema = schemas[key];
        if (!schema) continue;

        const result = await schema.safeParseAsync(req[key] ?? {});
        if (result.success) {
            req.validated[key] = result.data;
        } else {
            errors.push(...formatZodIssues(result.error.issues));
        }
    }

    if (errors.length > 0) {
        return next(ApiError.validation(errors));
    }

    next();
};

export default validate;
