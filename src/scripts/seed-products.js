/**
 * Creates or updates the stock form's brands and products from a JSON file
 * (default: data/stock-products.json). Brands and products are matched by name
 * (ignoring case and spacing), so the script is safe to run repeatedly.
 * Order in the file becomes the order on the form.
 *
 *   npm run seed:products
 *   npm run seed:products -- path/to/products.json
 *
 * File format: [{ "brand": "IDOL", "brandKh": "អាយដល", "products": ["IDOL"] }, ...]
 * Optional "measures": ["cases", ...] limits the quantities asked for that brand
 * (keys from stock.constants.js); without it the brand counts every quantity.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { Brand } from "../modules/stock/brand.model.js";
import { Product } from "../modules/stock/product.model.js";
import { MEASURE_KEYS } from "../modules/stock/stock.constants.js";
import { nameKey } from "../utils/names.js";

const fileSchema = z.array(
    z.object({
        brand: z.string().trim().min(1),
        brandKh: z.string().trim().default(""),
        measures: z.array(z.enum(MEASURE_KEYS)).min(1).optional(),
        products: z.array(z.string().trim().min(1)).min(1)
    })
);

const run = async () => {
    const argPath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
    const filePath = path.resolve(argPath || "data/stock-products.json");
    const entries = fileSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));

    await connectDatabase();
    await Promise.all([Brand.init(), Product.init()]);

    const stats = { brands: { created: 0, updated: 0 }, products: { created: 0, updated: 0 } };

    for (const [brandIndex, entry] of entries.entries()) {
        const brandResult = await Brand.findOneAndUpdate(
            { nameKey: nameKey(entry.brand) },
            {
                $set: {
                    name: entry.brand,
                    nameKh: entry.brandKh,
                    sortOrder: brandIndex,
                    ...(entry.measures && { measures: entry.measures })
                },
                // No list in the file = the brand counts every quantity
                ...(!entry.measures && { $unset: { measures: "" } }),
                $setOnInsert: { nameKey: nameKey(entry.brand), isActive: true }
            },
            { upsert: true, returnDocument: "after", includeResultMetadata: true }
        );
        stats.brands[brandResult.lastErrorObject?.updatedExisting ? "updated" : "created"]++;
        const brand = brandResult.value;

        for (const [productIndex, productName] of entry.products.entries()) {
            const productResult = await Product.findOneAndUpdate(
                { brandId: brand._id, nameKey: nameKey(productName) },
                {
                    $set: { name: productName, sortOrder: productIndex },
                    $setOnInsert: { nameKey: nameKey(productName), isActive: true }
                },
                { upsert: true, returnDocument: "after", includeResultMetadata: true }
            );
            stats.products[productResult.lastErrorObject?.updatedExisting ? "updated" : "created"]++;
        }
    }

    console.log(`Read ${path.relative(process.cwd(), filePath)}`);
    console.log(`Brands:   ${stats.brands.created} created, ${stats.brands.updated} updated`);
    console.log(`Products: ${stats.products.created} created, ${stats.products.updated} updated`);
};

try {
    await run();
} catch (error) {
    console.error("Product seed failed:", error.message);
    process.exitCode = 1;
} finally {
    await disconnectDatabase().catch(() => {});
}
