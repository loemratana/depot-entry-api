import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import config from "./config/env.js";
import routes from "./routes/index.js";
import notFound from "./middleware/notFound.middleware.js";
import errorHandler from "./middleware/error.middleware.js";

const app = express();

app.disable("x-powered-by");
// Needed behind a reverse proxy so rate limiting sees the real client IP
app.set("trust proxy", config.trustProxy);

app.use(helmet());
app.use(
    cors({
        origin: config.corsOrigin,
        credentials: true,
        // Let the frontend read the export filename and replay marker
        exposedHeaders: ["Content-Disposition", "Idempotent-Replayed"]
    })
);
app.use(morgan(config.isProduction ? "combined" : "dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

export default app;
