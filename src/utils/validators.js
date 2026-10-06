import mongoose from "mongoose";
import { z } from "zod";
import config from "../config/env.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./pagination.js";

export const objectId = (label = "ID") =>
    z
        .string({ error: `${label} is required` })
        .trim()
        .refine((value) => mongoose.isValidObjectId(value) && /^[a-f\d]{24}$/i.test(value), {
            message: `Invalid ${label}`
        });

/**
 * Cambodian local mobile/landline format agreed for the project:
 * a leading 0 followed by 8 or 9 digits (9–10 digits total).
 * Spaces, dashes, dots and parentheses are stripped first, and an
 * international +855 / 855 prefix is converted to the local 0 prefix.
 */
export const normalizePhone = (value) => {
    if (typeof value !== "string") return value;

    let digits = value.trim().replace(/[\s\-.()]/g, "");

    if (digits.startsWith("+855")) digits = `0${digits.slice(4)}`;
    else if (digits.startsWith("00855")) digits = `0${digits.slice(5)}`;
    else if (digits.startsWith("855") && digits.length >= 11) digits = `0${digits.slice(3)}`;

    return digits;
};

export const PHONE_PATTERN = /^0\d{8,9}$/;

export const isValidPhone = (value) => PHONE_PATTERN.test(normalizePhone(value));

export const phone = () =>
    z
        .string({ error: "Phone is required" })
        .transform(normalizePhone)
        .refine((value) => value.length > 0, { message: "Phone is required" })
        .refine((value) => PHONE_PATTERN.test(value), {
            message: "Invalid phone number. Use 9–10 digits starting with 0, e.g. 012345678"
        });

/**
 * Human names: NFC normalised and whitespace collapsed. No character-class
 * restriction, so Khmer combining vowels and subscripts are never rejected.
 */
export const personName = (label = "Name", { min = 2, max = 150 } = {}) =>
    z
        .string({ error: `${label} is required` })
        .transform((value) => value.normalize("NFC").replace(/\s+/g, " ").trim())
        .refine((value) => [...value].length >= min, { message: `${label} must be at least ${min} characters` })
        .refine((value) => [...value].length <= max, { message: `${label} must be at most ${max} characters` });

export const paginationQuery = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE)
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// Date and time without a time zone, as the filters send it (e.g. 2026-10-05T08:30)
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/;

/**
 * Accepts YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss] (both in the business time zone),
 * or a full ISO date-time with its own zone. `endOfDay` makes the end of a
 * range inclusive: a date covers the whole day, and HH:mm the whole minute.
 */
export const dateFilter = (label, { endOfDay = false } = {}) =>
    z
        .string()
        .trim()
        .optional()
        .transform((value, ctx) => {
            if (!value) return undefined;

            let date;
            const local = LOCAL_DATE_TIME.exec(value);
            if (DATE_ONLY.test(value)) {
                const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
                date = new Date(`${value}T${time}${config.utcOffset}`);
            } else if (local) {
                const seconds = local[2] ?? (endOfDay ? ":59" : ":00");
                const millis = endOfDay ? ".999" : ".000";
                date = new Date(`${local[1]}${seconds}${millis}${config.utcOffset}`);
            } else {
                date = new Date(value);
            }

            if (Number.isNaN(date.getTime())) {
                ctx.addIssue({ code: "custom", message: `Invalid ${label}. Use YYYY-MM-DD or YYYY-MM-DDTHH:mm` });
                return z.NEVER;
            }
            return date;
        });

export const optionalBoolean = () =>
    z
        .enum(["true", "false"])
        .optional()
        .transform((value) => (value === undefined ? undefined : value === "true"));
