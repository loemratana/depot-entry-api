import mongoose from "mongoose";
import config from "./env.js";

const READY_STATES = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting"
};

mongoose.connection.on("connected", () => {
    console.log("MongoDB connected");
});

mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected");
});

mongoose.connection.on("error", (error) => {
    console.error("MongoDB connection error:", error.message);
});

export const connectDatabase = async () => {
    mongoose.set("strictQuery", true);

    await mongoose.connect(config.mongodbUri, {
        maxPoolSize: config.mongodbMaxPoolSize,
        minPoolSize: config.mongodbMinPoolSize,
        // Under load, fail fast (503) instead of letting requests queue for a connection forever
        waitQueueTimeoutMS: config.mongodbWaitQueueTimeoutMs,
        serverSelectionTimeoutMS: 5000
    });
};

export const disconnectDatabase = async () => {
    if (mongoose.connection.readyState === 0) return;
    await mongoose.connection.close();
    console.log("MongoDB connection closed");
};

export const getDatabaseStatus = () => READY_STATES[mongoose.connection.readyState] || "unknown";
