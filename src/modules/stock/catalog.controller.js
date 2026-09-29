import ApiError from "../../utils/ApiError.js";
import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { STOCK_MEASURES } from "./stock.constants.js";
import * as catalogService from "./catalog.service.js";

// ---------- Public ----------

/** Streams a brand logo; the stock form on another domain shows it in an <img> */
export const getBrandLogo = asyncHandler(async (req, res) => {
    const logo = await catalogService.getBrandLogo(req.validated.params.id);
    if (!logo) throw ApiError.notFound("This brand has no logo");
    res.set({
        "Content-Type": logo.mimeType,
        // The URL changes (?v=) whenever the logo changes, so it can be cached for long
        "Cache-Control": "public, max-age=604800, immutable",
        // Helmet defaults to same-origin, which would block the admin site from showing it
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Content-Type-Options": "nosniff"
    });
    logo.stream.on("error", () => res.destroy());
    logo.stream.pipe(res);
});

// ---------- Admin ----------

export const listBrands = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    sendSuccess(res, { data: { measures: STOCK_MEASURES, brands: await catalogService.listBrands() } });
});

export const createBrand = asyncHandler(async (req, res) => {
    sendSuccess(res, { statusCode: 201, message: "Brand added", data: await catalogService.createBrand(req.validated.body) });
});

export const updateBrand = asyncHandler(async (req, res) => {
    const data = await catalogService.updateBrand(req.validated.params.id, req.validated.body);
    sendSuccess(res, { message: "Brand updated", data });
});

export const deleteBrand = asyncHandler(async (req, res) => {
    await catalogService.deleteBrand(req.validated.params.id);
    sendSuccess(res, { message: "Brand deleted" });
});

export const moveBrand = asyncHandler(async (req, res) => {
    const data = await catalogService.moveBrand(req.validated.params.id, req.validated.body.direction);
    sendSuccess(res, { data });
});

export const uploadLogo = asyncHandler(async (req, res) => {
    const data = await catalogService.setBrandLogo(req.validated.params.id, req.logo);
    sendSuccess(res, { message: "Logo updated", data });
});

export const removeLogo = asyncHandler(async (req, res) => {
    const data = await catalogService.removeBrandLogo(req.validated.params.id);
    sendSuccess(res, { message: "Logo removed", data });
});

export const createProduct = asyncHandler(async (req, res) => {
    const data = await catalogService.createProduct(req.validated.params.id, req.validated.body);
    sendSuccess(res, { statusCode: 201, message: "Product added", data });
});

export const updateProduct = asyncHandler(async (req, res) => {
    const data = await catalogService.updateProduct(req.validated.params.id, req.validated.body);
    sendSuccess(res, { message: "Product updated", data });
});

export const deleteProduct = asyncHandler(async (req, res) => {
    const data = await catalogService.deleteProduct(req.validated.params.id);
    sendSuccess(res, { message: "Product deleted", data });
});

export const moveProduct = asyncHandler(async (req, res) => {
    const data = await catalogService.moveProduct(req.validated.params.id, req.validated.body.direction);
    sendSuccess(res, { data });
});
