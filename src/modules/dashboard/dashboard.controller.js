import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { getDashboard } from "./dashboard.service.js";

export const dashboard = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    // Stock totals only for users who may see stock
    const data = await getDashboard(req.validated.query, { includeStock: req.permissions.has("stock.view") });
    sendSuccess(res, { data });
});
