import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import * as saleService from "./sale.service.js";

export const getPublicSales = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-cache");
    sendSuccess(res, { data: await saleService.listActiveSales() });
});

export const listSales = asyncHandler(async (req, res) => {
    const { data, pagination } = await saleService.listSales(req.validated.query);
    sendSuccess(res, { data, pagination });
});

export const createSale = asyncHandler(async (req, res) => {
    const data = await saleService.createSale(req.validated.body);
    sendSuccess(res, { statusCode: 201, message: "Sale GB created", data });
});

export const updateSale = asyncHandler(async (req, res) => {
    const data = await saleService.updateSale(req.validated.params.id, req.validated.body);
    sendSuccess(res, { message: "Sale GB updated", data });
});
