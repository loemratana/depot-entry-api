import crypto from "node:crypto";
import mongoose from "mongoose";
import { getObjectStream, putObjectFromBuffer } from "../../config/minio.js";
import ApiError from "../../utils/ApiError.js";
import { nameKey } from "../../utils/names.js";
import { removeUploadedObjects } from "../upload/upload.service.js";
import { Brand } from "./brand.model.js";
import { Product } from "./product.model.js";
import { measuresOf } from "./stock.constants.js";

/**
 * Admin management of the stock form's brands and products. Stock reports keep
 * brand/product name snapshots, so renaming or deleting never changes old reports.
 */

const isDuplicateKey = (error) => error?.code === 11000;

/** Relative to /api; the browser loads it from the API host (see getBrandLogo) */
export const logoPath = (brand) =>
    brand.logo?.objectKey
        ? `/public/stock/brands/${brand._id}/logo?v=${new Date(brand.logo.updatedAt).getTime()}`
        : null;

const toProduct = (product) => ({
    id: product._id.toString(),
    name: product.name,
    shortName: product.shortName ?? "",
    isActive: product.isActive,
    sortOrder: product.sortOrder
});

const toBrand = (brand, products = []) => ({
    id: brand._id.toString(),
    name: brand.name,
    nameKh: brand.nameKh ?? "",
    measures: measuresOf(brand),
    isActive: brand.isActive,
    sortOrder: brand.sortOrder,
    logoUrl: logoPath(brand),
    products: products.map(toProduct)
});

const findBrandOr404 = async (id) => {
    const brand = await Brand.findById(id);
    if (!brand) throw ApiError.notFound("Brand not found");
    return brand;
};

const findProductOr404 = async (id) => {
    const product = await Product.findById(id);
    if (!product) throw ApiError.notFound("Product not found");
    return product;
};

/** Every brand (active or not) with every product, in form order */
export const listBrands = async () => {
    const [brands, products] = await Promise.all([
        Brand.find().sort({ sortOrder: 1, name: 1 }).lean(),
        Product.find().sort({ sortOrder: 1, name: 1 }).lean()
    ]);
    return brands.map((brand) =>
        toBrand(
            brand,
            products.filter((product) => product.brandId.equals(brand._id))
        )
    );
};

const getBrand = async (id) => {
    const brand = await Brand.findById(id).lean();
    if (!brand) throw ApiError.notFound("Brand not found");
    const products = await Product.find({ brandId: brand._id }).sort({ sortOrder: 1, name: 1 }).lean();
    return toBrand(brand, products);
};

// ---------- Brands ----------

export const createBrand = async ({ name, nameKh = "", measures, isActive = true }) => {
    const last = await Brand.findOne().sort({ sortOrder: -1 }).select("sortOrder").lean();
    try {
        const brand = await Brand.create({
            name,
            nameKh,
            ...(measures && { measures }),
            isActive,
            sortOrder: (last?.sortOrder ?? -1) + 1
        });
        return getBrand(brand._id);
    } catch (error) {
        if (isDuplicateKey(error)) throw ApiError.conflict(`A brand named "${name}" already exists`);
        throw error;
    }
};

export const updateBrand = async (id, changes) => {
    const brand = await findBrandOr404(id);
    if (changes.name !== undefined) brand.name = changes.name;
    if (changes.nameKh !== undefined) brand.nameKh = changes.nameKh;
    if (changes.measures !== undefined) brand.measures = changes.measures;
    if (changes.isActive !== undefined) brand.isActive = changes.isActive;
    try {
        await brand.save();
    } catch (error) {
        if (isDuplicateKey(error)) throw ApiError.conflict(`A brand named "${changes.name}" already exists`);
        throw error;
    }
    return getBrand(id);
};

/** Deletes the brand, its products and its logo */
/**
 * The brand goes first, so a product being added at the same moment finds its
 * brand gone and removes itself (see createProduct); then its products and logo.
 */
export const deleteBrand = async (id) => {
    const brand = await Brand.findOneAndDelete({ _id: id }).select("logo").lean();
    if (!brand) throw ApiError.notFound("Brand not found");
    await Product.deleteMany({ brandId: brand._id });
    if (brand.logo?.objectKey) await removeUploadedObjects([brand.logo.objectKey]);
};

/** Swaps with the neighbour in form order, then renumbers 0..n so the order stays clean */
const move = async (Model, filter, id, direction) => {
    const siblings = await Model.find(filter).sort({ sortOrder: 1, name: 1 }).select("_id").lean();
    const index = siblings.findIndex((item) => item._id.equals(id));
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= siblings.length) return;
    [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
    await Model.bulkWrite(
        siblings.map((item, sortOrder) => ({ updateOne: { filter: { _id: item._id }, update: { $set: { sortOrder } } } }))
    );
};

export const moveBrand = async (id, direction) => {
    await findBrandOr404(id);
    await move(Brand, {}, new mongoose.Types.ObjectId(id), direction);
    return listBrands();
};

// ---------- Logo ----------

/** Replaces the brand's logo (an image already verified by content) */
/**
 * Swaps the logo in one atomic write and removes the object it actually replaced,
 * so two uploads at once leave exactly one logo in storage (no orphan, no dangling key).
 */
export const setBrandLogo = async (id, { buffer, mimeType, extension }) => {
    const brand = await findBrandOr404(id);
    const objectKey = `brands/${brand._id}/logo-${crypto.randomUUID()}.${extension}`;
    await putObjectFromBuffer(objectKey, buffer, mimeType);

    let previous;
    try {
        previous = await Brand.findOneAndUpdate(
            { _id: brand._id },
            { $set: { logo: { objectKey, mimeType, size: buffer.length, updatedAt: new Date() } } },
            { returnDocument: "before", projection: { logo: 1 } }
        ).lean();
    } catch (error) {
        await removeUploadedObjects([objectKey]);
        throw error;
    }
    if (!previous) {
        // Deleted while the logo was uploading
        await removeUploadedObjects([objectKey]);
        throw ApiError.notFound("Brand not found");
    }
    if (previous.logo?.objectKey) await removeUploadedObjects([previous.logo.objectKey]);
    return getBrand(id);
};

export const removeBrandLogo = async (id) => {
    const previous = await Brand.findOneAndUpdate(
        { _id: id },
        { $unset: { logo: 1 } },
        { returnDocument: "before", projection: { logo: 1 } }
    ).lean();
    if (!previous) throw ApiError.notFound("Brand not found");
    if (previous.logo?.objectKey) await removeUploadedObjects([previous.logo.objectKey]);
    return getBrand(id);
};

/** The logo's object stream and type, or null when the brand has no logo */
export const getBrandLogo = async (id) => {
    const brand = await Brand.findById(id).select("logo").lean();
    if (!brand?.logo?.objectKey) return null;
    return { stream: await getObjectStream(brand.logo.objectKey), mimeType: brand.logo.mimeType };
};

// ---------- Products ----------

export const createProduct = async (brandId, { name, shortName = "", isActive = true }) => {
    const brand = await findBrandOr404(brandId);
    const last = await Product.findOne({ brandId: brand._id }).sort({ sortOrder: -1 }).select("sortOrder").lean();
    try {
        const created = await Product.create({ brandId: brand._id, name, shortName, isActive, sortOrder: (last?.sortOrder ?? -1) + 1 });
        // The brand may have been deleted while this was being added: never leave an orphan
        if (!(await Brand.exists({ _id: brand._id }))) {
            await Product.deleteOne({ _id: created._id });
            throw ApiError.notFound("Brand not found");
        }
    } catch (error) {
        if (isDuplicateKey(error)) throw ApiError.conflict(`${brand.name} already has a product named "${name}"`);
        throw error;
    }
    return getBrand(brand._id);
};

export const updateProduct = async (id, changes) => {
    const product = await findProductOr404(id);
    if (changes.name !== undefined) {
        product.name = changes.name;
        product.nameKey = nameKey(changes.name);
    }
    if (changes.shortName !== undefined) product.shortName = changes.shortName;
    if (changes.isActive !== undefined) product.isActive = changes.isActive;
    try {
        await product.save();
    } catch (error) {
        if (isDuplicateKey(error)) throw ApiError.conflict(`This brand already has a product named "${changes.name}"`);
        throw error;
    }
    return getBrand(product.brandId);
};

export const deleteProduct = async (id) => {
    const product = await findProductOr404(id);
    await product.deleteOne();
    return getBrand(product.brandId);
};

export const moveProduct = async (id, direction) => {
    const product = await findProductOr404(id);
    await move(Product, { brandId: product.brandId }, product._id, direction);
    return getBrand(product.brandId);
};
