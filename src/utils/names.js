/** NFC, zero-width characters removed (common in Khmer text), whitespace collapsed */
export const cleanText = (value) =>
    String(value ?? "")
        .normalize("NFC")
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();

/**
 * Comparison key for names: two names with the same key are the same thing.
 * Ignores spaces, zero-width characters and letter case; COENG DA (្ដ) and
 * COENG TA (្ត) render identically in most fonts and are used interchangeably.
 */
export const nameKey = (value) =>
    cleanText(value)
        .replace(/\s/g, "")
        .replace(/្ដ/g, "្ត")
        .toLowerCase();
