import ApiError from "../../utils/ApiError.js";
import { nameKey } from "../../utils/names.js";
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

const DUPLICATE_NAME = () =>
    ApiError.conflict("A Sale GB with this name already exists", [
        { field: "name", message: "A Sale GB with this name already exists" }
    ]);

const isDuplicateName = (error) => error?.code === 11000 && "nameKey" in (error.keyPattern ?? {});

export const createSale = async (input) => {
    try {
        const sale = await Sale.create(input);
        return sale.toJSON();
    } catch (error) {
        if (isDuplicateName(error)) throw DUPLICATE_NAME();
        throw error;
    }
};

export const updateSale = async (id, changes) => {
    const sale = await Sale.findById(id);
    if (!sale) throw ApiError.notFound("Sale GB not found");

    // Saved through the document so the nameKey hook runs on renames
    for (const [key, value] of Object.entries(changes)) {
        sale.set(key, value === null ? undefined : value);
    }

    try {
        await sale.save();
    } catch (error) {
        if (isDuplicateName(error)) throw DUPLICATE_NAME();
        throw error;
    }
    return sale.toJSON();
};

/**
 * Sale GB typed on a form: returns the existing record with the same name key,
 * or creates it. The unique nameKey index makes concurrent first uses safe.
 */
export const findOrCreateSaleByName = async (name) => {
    const key = nameKey(name);
    const existing = await Sale.findOne({ nameKey: key }).lean();
    if (existing) return { sale: existing, created: false };

    try {
        const created = await Sale.create({ name });
        return { sale: created.toObject(), created: true };
    } catch (error) {
        if (!isDuplicateName(error)) throw error;
        // Another request created the same name a moment ago
        return { sale: await Sale.findOne({ nameKey: key }).lean(), created: false };
    }
};

/** Resolves a Sale GB chosen by id or typed by name; returns field errors instead of throwing */
export const resolveSaleSelection = async ({ saleGbId, saleGbName }) => {
    const field = saleGbId ? "saleGbId" : "saleGbName";
    const sale = saleGbId
        ? await Sale.findById(saleGbId).lean()
        : (await findOrCreateSaleByName(saleGbName)).sale;

    if (!sale) return { sale: null, errors: [{ field, message: "Sale GB not found" }] };
    if (!sale.isActive) return { sale, errors: [{ field, message: "This Sale GB is no longer available" }] };

    return { sale, errors: [] };
};
