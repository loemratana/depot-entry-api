import { Router } from "express";
import { publicApiLimiter } from "../middleware/rateLimit.middleware.js";
import locationRoutes from "../modules/location/location.routes.js";
import { publicSaleRoutes } from "../modules/sale/sale.routes.js";
import { publicStockRoutes } from "../modules/stock/stock.routes.js";
import { publicSubmissionRoutes } from "../modules/submission/submission.routes.js";

const router = Router();

router.use(publicApiLimiter);

router.use("/locations", locationRoutes);
router.use("/sales", publicSaleRoutes);
router.use("/submissions", publicSubmissionRoutes);
router.use("/stock", publicStockRoutes);

export default router;
