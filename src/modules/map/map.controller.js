import asyncHandler from "../../utils/asyncHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { listMapPoints, MAX_MAP_POINTS } from "./map.service.js";

export const listSubmissionPoints = asyncHandler(async (req, res) => {
    // GPS and presigned photo URLs must not be cached by browsers or proxies
    res.set("Cache-Control", "no-store");
    const { points, truncated } = await listMapPoints(req.validated.query);
    sendSuccess(res, {
        message: truncated ? `Showing the first ${MAX_MAP_POINTS} photos. Narrow the filters to see the rest.` : undefined,
        data: points
    });
});
