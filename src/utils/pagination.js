export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const getPagination = ({ page = 1, limit = DEFAULT_PAGE_SIZE }) => ({
    page,
    limit,
    skip: (page - 1) * limit
});

export const buildPagination = ({ page, limit, total }) => {
    const totalPages = Math.ceil(total / limit);

    return {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
    };
};

export const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
