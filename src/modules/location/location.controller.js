import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import * as locationService from "./location.service.js";

// Admins can edit locations at any time, so browsers must revalidate (the frontend caches in memory)
const noCache = (res) => res.set("Cache-Control", "no-cache");

export const getProvinces = asyncHandler(async (req, res) => {
    noCache(res);
    sendSuccess(res, { data: await locationService.listProvinces() });
});

export const getDistricts = asyncHandler(async (req, res) => {
    noCache(res);
    sendSuccess(res, { data: await locationService.listDistricts(req.validated.query.provinceId) });
});

export const getCommunes = asyncHandler(async (req, res) => {
    noCache(res);
    const { districtId, provinceId } = req.validated.query;
    sendSuccess(res, { data: await locationService.listCommunes(districtId, provinceId) });
});

// ---------- Admin ----------

export const getSummary = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    sendSuccess(res, { data: await locationService.getLocationSummary() });
});

export const importLocations = asyncHandler(async (req, res) => {
    const { dryRun } = req.validated.query;
    const data = await locationService.importLocations(req.file.buffer, {
        dryRun,
        fileName: req.file.originalname
    });
    sendSuccess(res, { message: dryRun ? "File checked. Nothing was saved yet" : "Locations imported", data });
});

export const downloadTemplate = asyncHandler(async (req, res) => {
    res.set({
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="location-template.xlsx"',
        "Cache-Control": "no-store"
    });
    await locationService.writeTemplate(res);
    res.end();
});

export const listLocations = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { data, groups, pagination } = await locationService.listLocationRows(req.validated.query);
    res.json({ success: true, data, groups, pagination });
});

export const createLocation = (level) =>
    asyncHandler(async (req, res) => {
        const data = await locationService.createLocation(level, req.validated.body);
        sendSuccess(res, { statusCode: 201, message: "Location created", data });
    });

export const updateLocation = (level) =>
    asyncHandler(async (req, res) => {
        const data = await locationService.updateLocation(level, req.validated.params.id, req.validated.body);
        sendSuccess(res, { message: "Location updated", data });
    });

export const deleteLocation = (level) =>
    asyncHandler(async (req, res) => {
        await locationService.deleteLocation(level, req.validated.params.id);
        sendSuccess(res, { message: "Location deleted" });
    });
