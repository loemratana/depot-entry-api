import config from "./config/env.js";
import app from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { ensureBucket } from "./config/minio.js";
import { backfillSaleNameKeys } from "./modules/sale/sale.model.js";
import { ensureRbac } from "./modules/rbac/rbac.service.js";
import { backfillProductShortNames } from "./modules/stock/product.model.js";
import { completePendingStockReports } from "./modules/submission/submission.service.js";

const SHUTDOWN_TIMEOUT_MS = 10000;

let server;
let isShuttingDown = false;

const shutdown = async (signal, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`${signal} received. Shutting down gracefully...`);

    const forceExit = setTimeout(() => {
        console.error("Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
        if (server) {
            await new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeIdleConnections?.();
            });
            console.log("HTTP server closed");
        }

        await disconnectDatabase();
    } catch (error) {
        console.error("Error during shutdown:", error);
        exitCode = 1;
    }

    process.exit(exitCode);
};

const start = async () => {
    try {
        await connectDatabase();
        await backfillSaleNameKeys();

        // Built-in roles; accounts from before roles existed become Super Admin
        const { migratedAdmins } = await ensureRbac();
        if (migratedAdmins) console.log(`Gave Super Admin to ${migratedAdmins} existing admin(s)`);

        // Dashboard card labels for the original products (only where none is set)
        await backfillProductShortNames();

        // Finishes stock reports interrupted by a previous stop (normally none)
        try {
            const finished = await completePendingStockReports();
            if (finished) console.log(`Finished ${finished} pending stock report(s)`);
        } catch (error) {
            console.error("Could not finish pending stock reports:", error.message);
        }

        // Storage problems should not stop admins from browsing data, so this is non-fatal.
        // Submissions return 503 until MinIO is reachable.
        try {
            await ensureBucket();
            console.log(`MinIO ready (bucket "${config.minio.bucket}")`);
        } catch (error) {
            console.error("MinIO unavailable, file uploads will fail until it is reachable:", error.message);
        }

        server = app.listen(config.port, () => {
            console.log(`Server running on port ${config.port} (${config.nodeEnv})`);
        });
    } catch (error) {
        console.error("Failed to start server:", error.message);
        process.exit(1);
    }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
    shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    shutdown("uncaughtException", 1);
});

start();
