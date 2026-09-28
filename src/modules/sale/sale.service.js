import ApiError from "../../utils/ApiError.js";
import { buildPagination, escapeRegex, getPagination } from "../../utils/pagination.js";
import { Sale } from "./sale.model.js";

export const listActiveSales = async () => {
    const docs = await Sale.find({ isActive: true }).select("name code").sort({ name: 1, _id: 1 }).lean();
    return docs.map((doc) => ({ id: doc._id.toString(), name: doc.name, code: doc.code ?? null }));
};

export const listSales = async ({ search, isActive, page, limit }) => {
    const filter = {};

    if (isActive !== undefined) filter.isActive = isActive;
    if (search) {
        const pattern = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ name: pattern }, { code: pattern }, { phone: pattern }];
    }

    const { skip } = getPagination({ page, limit });

    const [docs, total] = await Promise.all([
        Sale.find(filter).sort({ name: 1, _id: 1 }).skip(skip).limit(limit),
        Sale.countDocuments(filter)
    ]);

    return {
        data: docs.map((doc) => doc.toJSON()),
        pagination: buildPagination({ page, limit, total })
    };
};

export const createSale = async (input) => {
    const sale = await Sale.create(input);
    return sale.toJSON();
};

export const updateSale = async (id, changes) => {
    const $set = {};
    const $unset = {};

    for (const [key, value] of Object.entries(changes)) {
        if (value === null) $unset[key] = "";
        else $set[key] = value;
    }

    const update = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;

    const sale = await Sale.findByIdAndUpdate(id, update, { new: true, runValidators: true });

    if (!sale) throw ApiError.notFound("Sale GB not found");

    return sale.toJSON();
};

export const resolveSaleSelection = async (saleGbId) => {
    const sale = await Sale.findById(saleGbId).lean();

    if (!sale) return { sale: null, errors: [{ field: "saleGbId", message: "Sale GB not found" }] };
    if (!sale.isActive) return { sale, errors: [{ field: "saleGbId", message: "Sale GB is not available" }] };

    return { sale, errors: [] };
};
