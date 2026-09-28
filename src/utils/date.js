import config from "../config/env.js";

const offsetMs = (() => {
    const [, sign, hours, minutes] = config.utcOffset.match(/([+-])(\d{2}):(\d{2})/);
    return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60 * 1000;
})();

/** Shifts a UTC instant so its UTC fields read as business-local wall time. */
export const toBusinessWallTime = (date) => new Date(date.getTime() + offsetMs);

/** YYYY-MM-DD in the business time zone. */
export const businessDate = (date = new Date()) => toBusinessWallTime(date).toISOString().slice(0, 10);
