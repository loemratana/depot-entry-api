export const sendSuccess = (res, { statusCode = 200, message, data, pagination } = {}) => {
    const body = { success: true };

    if (message) body.message = message;
    if (data !== undefined) body.data = data;
    if (pagination) body.pagination = pagination;

    return res.status(statusCode).json(body);
};
