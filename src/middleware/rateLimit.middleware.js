import { rateLimit } from "express-rate-limit";
import config from "../config/env.js";

const limitReached = (message) => (req, res, next, options) => {
    res.status(options.statusCode).json({ success: false, message });
};

// The default in-memory store is per process. Swap in a shared store
// (e.g. rate-limit-mongo) when running more than one instance.
const common = {
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => config.isTest
};

// Only failed logins are limited (password guessing); public routes and
// outlet submissions have no rate limit
export const loginLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: config.rateLimit.loginMax,
    skipSuccessfulRequests: true,
    handler: limitReached("Too many login attempts. Please try again in 15 minutes")
});

// Only failed refreshes count, so normal use is never limited
export const refreshLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: config.rateLimit.loginMax,
    skipSuccessfulRequests: true,
    handler: limitReached("Too many attempts. Please log in again in 15 minutes")
});
