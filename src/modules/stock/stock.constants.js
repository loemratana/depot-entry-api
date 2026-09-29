/**
 * Quantities counted for every product in a stock report, in form order.
 * Keys are stored in the database; labels are shown on the form and in exports.
 */
export const STOCK_MEASURES = Object.freeze([
    { key: "cases", kh: "ចំនួនកេស", en: "Cases" },
    { key: "canRings", kh: "ចំនួនក្រវិលកំប៉ុង", en: "Can rings" },
    { key: "cashRingsUsd", kh: "ចំនួនក្រវិលលុយ(ដុល្លា)", en: "Cash rings (USD)" },
    { key: "cashRingsKhr", kh: "ចំនួនក្រវិលលុយ(រៀល)", en: "Cash rings (KHR)" }
]);

export const MEASURE_KEYS = STOCK_MEASURES.map((measure) => measure.key);

/**
 * The quantities a brand (or a report item's snapshot) counts; without a list,
 * all of them. Keys that no longer exist are dropped.
 */
export const measuresOf = (brand) =>
    brand?.measures?.length ? brand.measures.filter((key) => MEASURE_KEYS.includes(key)) : MEASURE_KEYS;

// Upper bound per quantity, to catch typos such as an extra few zeros
export const MAX_QUANTITY = 1_000_000;
