import { Router } from "express";
import config from "../config/env.js";
import { getDatabaseStatus } from "../config/database.js";
import { getStorageStatus } from "../config/minio.js";
import asyncHandler from "../utils/asyncHandler.js";

const router = Router();

router.get(
    "/",
    asyncHandler(async (req, res) => {
        const database = getDatabaseStatus();
        const storage = await getStorageStatus();
        const healthy = database === "connected" && storage === "connected";

        res.set("Cache-Control", "no-store");
        res.status(healthy ? 200 : 503).json({
            success: healthy,
            status: healthy ? "ok" : "degraded",
            environment: config.nodeEnv,
            database,
            storage,
            timestamp: new Date().toISOString()
        });
    })
);

export default router;
