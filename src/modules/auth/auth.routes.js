import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requireAdmin } from "../../middleware/auth.middleware.js";
import { loginLimiter, refreshLimiter } from "../../middleware/rateLimit.middleware.js";
import { loginSchema, logoutSchema, refreshSchema } from "./auth.validation.js";
import * as authController from "./auth.controller.js";

const router = Router();

router.post("/login", loginLimiter, validate(loginSchema), authController.login);
router.post("/refresh", refreshLimiter, validate(refreshSchema), authController.refresh);
router.get("/me", requireAdmin, authController.me);
router.post("/logout", requireAdmin, validate(logoutSchema), authController.logout);

export default router;
