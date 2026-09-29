# Production image for the API. MongoDB is NOT part of this image or the
# production compose file: the API connects to the MongoDB already running on
# the VPS through MONGODB_URI in the server's .env file.

# Debian slim (glibc): bcrypt ships prebuilt Linux binaries for glibc, not musl/Alpine
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Seed/import data used by the npm scripts (seed:products, import:locations, ...)
COPY data ./data

# Never run as root
USER node

EXPOSE 5000

# Healthy when the API answers /api/health (uses Node's built-in fetch; the image has no curl)
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
