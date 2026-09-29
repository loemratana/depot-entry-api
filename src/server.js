import config from "./config/env.js";
import app from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { ensureBucket } from "./config/minio.js";
import { backfillSaleNameKeys } from "./modules/sale/sale.model.js";

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
