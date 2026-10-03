import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { getDashboard, getProvinceStock } from "./dashboard.service.js";

export const dashboard = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    // Stock totals only for users who may see stock
    const data = await getDashboard(req.validated.query, { includeStock: req.permissions.has("stock.view") });
    sendSuccess(res, { data });
});

export const provinceStock = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    sendSuccess(res, { data: await getProvinceStock(req.validated.query) });
});
