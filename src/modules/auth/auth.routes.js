import { Router } from "express";
import validate from "../../middleware/validate.middleware.js";
import { requireAdmin } from "../../middleware/auth.middleware.js";
import { loginLimiter } from "../../middleware/rateLimit.middleware.js";
import { loginSchema } from "./auth.validation.js";
import * as authController from "./auth.controller.js";

const router = Router();

router.post("/login", loginLimiter, validate(loginSchema), authController.login);
router.get("/me", requireAdmin, authController.me);
router.post("/logout", requireAdmin, authController.logout);

export default router;
