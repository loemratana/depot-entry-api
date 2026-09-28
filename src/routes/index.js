import { Router } from "express";
import config from "../config/env.js";
import healthRoutes from "./health.routes.js";
import publicRoutes from "./public.routes.js";
import adminRoutes from "./admin.routes.js";
import docsRoutes from "./docs.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/public", publicRoutes);
router.use("/admin", adminRoutes);

if (config.swaggerEnabled) {
    router.use("/", docsRoutes);
}

export default router;
