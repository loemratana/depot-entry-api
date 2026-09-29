/**
 * Removes stock quantities that are no longer collected:
 *   kula  (ចំនួនទឹកលុយគុល្លា)
 *   rings (ចំនួនក្រវិល)
 * Deletes their stored values from every stock report and drops them from brand
 * and report field lists. Safe to run more than once.
 *
 *   npm run migrate:remove-retired-measures
 */
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { Brand } from "../modules/stock/brand.model.js";
import { StockReport } from "../modules/stock/stockReport.model.js";

export const RETIRED_MEASURES = ["kula", "rings"];

const run = async () => {
    await connectDatabase();
    const reports = StockReport.collection;

    for (const key of RETIRED_MEASURES) {
        const withValues = await reports.countDocuments({ [`items.${key}`]: { $gt: 0 } });
        const values = await reports.updateMany(
            { [`items.${key}`]: { $exists: true } },
            { $unset: { [`items.$[].${key}`]: "" } }
        );
        console.log(`${key}: removed from ${values.modifiedCount} stock report(s) (${withValues} had a value above 0)`);
    }

    const reportLists = await reports.updateMany(
        { "items.measures": { $in: RETIRED_MEASURES } },
        { $pull: { "items.$[].measures": { $in: RETIRED_MEASURES } } }
    );
    const brandLists = await Brand.collection.updateMany(
        { measures: { $in: RETIRED_MEASURES } },
        { $pull: { measures: { $in: RETIRED_MEASURES } } }
    );
    console.log(`Report field lists updated: ${reportLists.modifiedCount}`);
    console.log(`Brand field lists updated: ${brandLists.modifiedCount}`);
};

try {
    await run();
} catch (error) {
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
} finally {
    await disconnectDatabase().catch(() => {});
}
