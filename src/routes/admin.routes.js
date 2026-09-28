import { Router } from "express";
import { requireAdmin } from "../middleware/auth.middleware.js";
import authRoutes from "../modules/auth/auth.routes.js";
import { adminLocationRoutes } from "../modules/location/location.routes.js";
import { adminSaleRoutes } from "../modules/sale/sale.routes.js";
import { adminSubmissionRoutes } from "../modules/submission/submission.routes.js";

const router = Router();

// Auth routes handle their own protection (login is public)
router.use("/auth", authRoutes);

// Everything below requires a valid admin token
router.use(requireAdmin);

router.use("/submissions", adminSubmissionRoutes);
router.use("/sales", adminSaleRoutes);
router.use("/locations", adminLocationRoutes);

export default router;
