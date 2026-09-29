import ApiError from "./ApiError.js";

/**
 * In-process concurrency limiter for memory-heavy work (e.g. exports that hold
 * photos in memory). At most `concurrency` tasks run at once; up to `maxQueue`
 * more wait (each at most `queueTimeoutMs`); beyond that callers get a 503 with
 * Retry-After instead of pushing the process out of memory.
 */
export const createLimiter = ({ concurrency, maxQueue, queueTimeoutMs, busyMessage }) => {
    let running = 0;
    const queue = [];

    const busy = () => {
        const error = ApiError.serviceUnavailable(busyMessage);
        error.retryAfterSeconds = Math.ceil(queueTimeoutMs / 1000 / 4);
        return error;
    };

    const release = () => {
        running--;
        const next = queue.shift();
        if (next) {
            clearTimeout(next.timer);
            running++;
            next.resolve();
        }
    };

    const acquire = () => {
        if (running < concurrency) {
            running++;
            return Promise.resolve();
        }
        if (queue.length >= maxQueue) return Promise.reject(busy());
        return new Promise((resolve, reject) => {
            const waiter = { resolve };
            waiter.timer = setTimeout(() => {
                const index = queue.indexOf(waiter);
                if (index >= 0) queue.splice(index, 1);
                reject(busy());
            }, queueTimeoutMs);
            waiter.timer.unref?.();
            queue.push(waiter);
        });
    };

    return {
        /** Runs `task` when a slot is free; the slot is released when it settles */
        async run(task) {
            await acquire();
            try {
                return await task();
            } finally {
                release();
            }
        },
        stats: () => ({ running, waiting: queue.length })
    };
};
