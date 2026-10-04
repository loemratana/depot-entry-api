# Client Management Backend

[![CI](https://github.com/loemratana/depot-entry-api/actions/workflows/ci.yml/badge.svg)](https://github.com/loemratana/depot-entry-api/actions/workflows/ci.yml)

Express + MongoDB + MinIO API for the Client Data Collection & Management System: a public client submission form with Province → District → Commune cascading locations and document uploads, plus an admin area for search, filtering, document viewing and Excel export.

## Requirements

- Node.js 20+ (developed on Node 24)
- Docker Desktop (runs MongoDB 8 and MinIO; the Node app runs directly on your machine)

## Quick start

```bash
cp .env.example .env          # then fill in the secrets (see below)
docker compose up -d          # MongoDB :27017 and MinIO :9000/:9001, bound to 127.0.0.1 only
npm install
npm run seed:admin            # creates the admin from ADMIN_EMAIL / ADMIN_PASSWORD
npm run seed:sales            # optional: Sale GB entries from data/sales.json
npm run import:locations      # imports data/location.xlsx
npm run dev                   # http://localhost:5000
```

- Health: http://localhost:5000/api/health
- API docs (Swagger UI): http://localhost:5000/api/docs
- MinIO console: http://127.0.0.1:9001 (log in with `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`)

## Environment configuration

All variables are documented in [.env.example](.env.example) and validated at startup with Zod (`src/config/env.js`). The app refuses to start with a list of the invalid variable names; values are never printed.

| Variable | Purpose |
|---|---|
| `MONGO_ROOT_USERNAME`, `MONGO_ROOT_PASSWORD` | Used by Docker Compose to create the MongoDB root user **on first start only** |
| `MONGODB_URI` | Connection string; must use the same credentials |
| `MONGODB_MAX_POOL_SIZE`, `MONGODB_MIN_POOL_SIZE` | Mongoose connection pool (default 20 / 2) |
| `CORS_ORIGIN` | Comma-separated allowed origins. `*` is rejected in production |
| `TRUST_PROXY` | Set to `1` behind one reverse proxy so rate limiting sees real client IPs |
| `APP_UTC_OFFSET` | Business time zone (default `+07:00`) for submission numbers, date filters and export times |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_EXPIRES_DAYS` | Admin token signing and lifetimes (default 14d access, 30 days refresh). Secret must be 32+ chars in production |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Initial admin for `npm run seed:admin` |
| `MINIO_*` | MinIO connection and bucket. Access/secret key are also the MinIO root credentials in Docker Compose |
| `FILE_URL_EXPIRY_SECONDS` | Lifetime of document links shown to admins (default 900) |
| `MAX_FILES_PER_SUBMISSION`, `MAX_FILE_SIZE_MB`, `ALLOWED_FILE_TYPES` | Upload limits |
| `LOGIN_RATE_LIMIT_MAX` | Failed logins allowed per IP per 15 min (public routes and submissions have no rate limit) |
| `SWAGGER_ENABLED` | Serve `/api/docs` (defaults to on outside production) |

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`.env` is git-ignored. Never commit it.

## Docker services

```bash
docker compose up -d        # start
docker compose ps           # status
docker compose down         # stop, keeps data
```

Data lives in the named volumes `mongodb_data` and `minio_data`, so `docker compose down` keeps it. Only `docker compose down -v` deletes it.

MinIO no longer publishes free images to Docker Hub or Quay, so Compose uses Chainguard's maintained build (`cgr.dev/chainguard/minio`). It has no shell, so there is no container healthcheck. Use `GET /api/health`, which checks MinIO directly. The app creates the bucket on startup if it is missing.

`docker-compose.yml` is for local development only.

## Deploy to VPS (CI/CD)

`.github/workflows/ci.yml` runs on every push and pull request:

1. **test**: the test suite on Node 22 and 24, against a throwaway MongoDB and MinIO inside GitHub Actions. The tests wipe their database, so they never touch the MongoDB on the VPS.
2. **docker**: builds the production image and validates `docker-compose.prod.yml`.
3. **deploy** (pushes to `main` only, after both pass): connects to the VPS over SSH, pulls `main`, runs `docker compose -f docker-compose.prod.yml up -d --build`, and fails if the API does not report healthy.

Production runs **only the API** in Docker. **MongoDB and MinIO are not in Docker**: the API uses the MongoDB and MinIO already on the VPS through `MONGODB_URI` and `MINIO_*` in the server's `.env`. The API container uses host networking, so `mongodb://...@127.0.0.1:27017/...` on the VPS works as-is. For MinIO, see the `MINIO_ENDPOINT` note below. It listens on `PORT`; put Nginx (HTTPS) in front of it.

### One-time server setup

```bash
git clone https://github.com/loemratana/depot-entry-api.git ~/apps/client-management
cd ~/apps/client-management
cp .env.example .env    # fill in real values: MONGODB_URI (VPS MongoDB), JWT_SECRET, MINIO_*, CORS_ORIGIN, TRUST_PROXY
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api npm run seed:admin
```

Production `.env` notes:

- `NODE_ENV=production`, and `TRUST_PROXY=1` behind Nginx (for correct client IPs in rate limiting).
- `MINIO_ENDPOINT` / `MINIO_PORT` / `MINIO_USE_SSL` must be the address admins' browsers can reach (for example `files.example.com`, 443, `true` via Nginx). Photo and document links are presigned for that host.
- The camera and GPS on the public form only work when it is opened over **https**.

### GitHub secrets (Settings → Secrets and variables → Actions)

| Secret | Value |
| --- | --- |
| `VPS_HOST` | Server IP or hostname |
| `VPS_USER` | SSH user that owns `~/apps/client-management` and can run `docker` |
| `VPS_SSH_KEY` | Private key for that user (the public key goes in the server's `~/.ssh/authorized_keys`) |
| `VPS_HOST_KEY` | Server host key fingerprint: the `SHA256:...` part of `ssh-keyscan -p 2244 <host> \| ssh-keygen -lf -` |

The workflow connects on SSH port `2244`.

## Seeding

### Admin

```bash
npm run seed:admin                     # create if missing; never duplicates
npm run seed:admin -- --reset-password # also reset the password to ADMIN_PASSWORD
```

Safe to run repeatedly. In production it refuses the example `change_me` password. The seeded admin is a **Super Admin**; add everyone else from the admin's Users page.

### Sale GB

```bash
cp data/sales.example.json data/sales.json   # edit with real names
npm run seed:sales
npm run seed:sales -- path/to/other.json
```

Entries are matched by `code`, so re-running updates names instead of duplicating. Sale GB entries can also be managed through the admin API.

## Location import

**From the admin panel (recommended):** open **Locations** in the sidebar, optionally download the template (columns `ខេត្ត/ក្រុង · ខណ្ឌ/ស្រុក · ឃុំ/ភូមិ`), and upload your `.xlsx` file. The file is checked first, which shows what will be added, updated or already exists, plus duplicate names and skipped rows. Nothing is saved until you click **Import**. The endpoints are `POST /api/admin/locations/import?dryRun=true|false`, `GET /api/admin/locations/summary` and `GET /api/admin/locations/template`.

**Managing locations:** the same page lists every location (sorted by province) and lets admins add, rename, activate/deactivate and delete provinces, districts and communes. The endpoints are `GET /api/admin/locations`, plus `POST /api/admin/locations/{provinces|districts|communes}` and `PATCH`/`DELETE` on `…/{level}/:id`. Delete is refused while a location still has children or is used by a submission; deactivate it instead, which hides it from the forms and filters and keeps past submissions intact.

**Name uniqueness:** a name can exist only once under the same parent (province → district → commune). Names are compared ignoring spaces, zero-width characters, letter case and the interchangeable subscripts ្ដ/្ត. This applies within the file (later spellings are reported and merged into the first) and against the database (an existing location is matched by code, then by name), so re-uploading never creates duplicates. The same commune name under two different districts is allowed. Prefixes such as `ខេត្ត` or `រាជធានី` are part of the name, so `ខេត្តកណ្ដាល` and `កណ្ដាល` are different names.

**From the command line:**

```bash
npm run import:locations                                   # data/location.xlsx
npm run import:locations -- "path/to/location.xlsx"
npm run import:locations -- location.xlsx --dry-run        # parse and report only
npm run import:locations -- location.xlsx --sheet "Sheet1" --strict
```

The importer reads every sheet, finds the header row (English or Khmer headings), and reports what it found before writing:

- rows read, blank rows skipped, rows that inherited a parent
- unique provinces / districts / communes
- invalid rows (with sheet and row number), which are **not** imported
- warnings, such as codes that don't match their parent prefix
- created / updated / unchanged counts per level

`--strict` aborts without writing anything if there is any invalid row.

**Supported layouts**

1. **Flat**: one row per commune, with Province / District / Commune columns (e.g. `ខេត្ត`, `Province`, `Province Code`, `ស្រុក/ខណ្ឌ`, `ឃុំ/សង្កាត់`). If there is no commune column but a village column, the village column is used as the third level.
2. **Gazetteer**: one row per unit with a `Code` column and name columns. The level comes from the code length (2 = province, 4 = district, 6 = commune, 8 = village, which is skipped) and the parent from the code prefix.

**Assumptions**

- Text containing Khmer characters is stored as `nameKh`; Latin text as `nameEn`. Text is NFC-normalised, whitespace is collapsed and zero-width characters are removed. Prefixes such as "ខេត្ត" are kept as they are in the source.
- In the flat layout, a row with a child value but blank parent cells (Excel visual grouping) inherits the last parent on the same sheet. A district is never inherited across provinces. A row with nothing to inherit is reported as invalid. Merged cells are read as their top-left value.
- Numeric codes that lost a leading zero in Excel (`102`) are padded to an even length (`0102`).
- Without code columns, the Khmer name is used as the stable key within its parent.
- Re-importing updates renamed locations but never re-activates a location an admin set `isActive: false`.

## Development

```bash
npm run dev     # nodemon, restarts on changes in src/
npm start       # plain node
npm test        # integration tests (see Testing)
```

## API overview

Full interactive documentation with example values is at `/api/docs`. Responses use one format:

```json
{ "success": true, "message": "optional", "data": {}, "pagination": {} }
{ "success": false, "message": "Validation failed", "errors": [{ "field": "phone", "message": "Invalid phone number" }] }
```

| Method | Path | Auth |
|---|---|---|
| GET | `/api/health` | – |
| GET | `/api/public/locations/provinces` | – |
| GET | `/api/public/locations/districts?provinceId=` | – |
| GET | `/api/public/locations/communes?districtId=` | – |
| GET | `/api/public/sales` | – |
| POST | `/api/public/submissions` | – (rate limited) |
| POST | `/api/admin/auth/login` | – (rate limited) |
| GET | `/api/admin/auth/me` | Bearer |
| POST | `/api/admin/auth/logout` | Bearer |
| GET | `/api/admin/submissions` | Bearer |
| GET | `/api/admin/submissions/export` | Bearer |
| GET | `/api/admin/submissions/:id` | Bearer |
| GET | `/api/admin/sales` | Bearer |
| POST | `/api/admin/sales` | Bearer |
| PATCH | `/api/admin/sales/:id` | Bearer |

### Public submission

`POST /api/public/submissions` as `multipart/form-data` with `clientName`, `phone`, `provinceId`, `districtId`, `communeId`, `saleGbId` and one or more `files` (or `files[]`).

- **Client name**: trimmed, whitespace collapsed, at least 2 characters. No character restrictions, so all Khmer names are accepted.
- **Phone**: spaces, dashes, dots and parentheses are removed, and `+855` becomes `0`. The result must be `0` followed by 8–9 digits (9–10 digits total). The normalised value is stored.
- **Locations / Sale GB**: must exist and be active. The district must belong to the province and the commune to the district. The server looks up the names and stores them with the IDs, and ignores any names sent by the client.
- **Submission number**: `CL-YYYYMMDD-XXXXXXXX` (business-local date plus 8 random Crockford base32 characters). A unique index guarantees uniqueness, and a collision is retried.
- **Idempotency**: send an `Idempotency-Key: <8–128 chars>` header. Repeating the key returns the original submission number with `200` and `Idempotent-Replayed: true`. Concurrent duplicates are resolved by a unique index, and the losing request's uploaded files are removed.

### File upload restrictions

- At least 1 file, at most `MAX_FILES_PER_SUBMISSION` (10), each at most `MAX_FILE_SIZE_MB` (10 MB).
- Allowed: JPEG, PNG, WebP and PDF. The type is checked from the file's **content** (magic bytes) and must match the declared type. A renamed `.exe` is rejected with 415.
- Uploads go to a temp directory, not memory, and are deleted when the request finishes.
- Files are stored in MinIO as `submissions/{submissionId}/{uuid}.{ext}`. The original filename is kept only as metadata. MongoDB stores metadata and the object key, never file contents.
- **Consistency**: files are uploaded only after every validation passes. If an upload fails, the files already uploaded for that request are removed. If the database insert fails, all of the request's files are removed. Existing files are never touched.

### Authentication

`POST /api/admin/auth/login` with `{ "email", "password" }` returns a JWT access token (HS256, `JWT_EXPIRES_IN`, default 14 days) and a refresh token (`REFRESH_TOKEN_EXPIRES_DAYS`, default 30 days). Send the access token as `Authorization: Bearer <token>`. `POST /api/admin/auth/refresh` with `{ "refreshToken" }` returns a new access token and a new refresh token; the old refresh token stops working, and reusing a used one ends that whole session. Refresh tokens are stored only as SHA-256 hashes. Passwords are hashed with bcrypt (12 rounds) and never returned. Logout revokes that access token (its ID is stored in `revokedtokens` until it would have expired anyway) and, when `{ "refreshToken" }` is sent, its refresh session. Every request re-checks that the admin still exists and is active.

### Roles and permissions

Every `/api/admin/*` endpoint (except login, refresh, `/me` and logout) requires a permission; without it the API returns `403`. The list of permissions is in [src/modules/rbac/permissions.js](src/modules/rbac/permissions.js) (e.g. `outlets.view`, `outlets.delete`, `stock.export`, `users.manage`).

- Each user has one **role**; a role is a set of permissions, managed under `/api/admin/roles` (Roles page).
- Built-in roles are created on first start and never overwritten afterwards: **Super Admin** (every permission, cannot be edited or deleted), **Manager** (all but users and roles), **Staff** (view and record; no delete, export or import) and **Viewer** (read-only).
- Accounts from before roles existed are given Super Admin at startup, so nobody is locked out by the upgrade.
- Permissions are read on every request, so changing a role or a user's role applies immediately; deactivating a user or resetting their password also ends their refresh sessions.
- Safety rules: only a Super Admin can create, edit or promote Super Admins; you cannot change your own role or deactivate yourself; the last active Super Admin cannot be demoted or deactivated; a role still assigned to users cannot be deleted.
- `/me` and login return the user's `role` and `permissions`, which the admin UI uses to hide pages and buttons. The API enforces the rules either way.

### Filtering and pagination

`GET /api/admin/submissions` accepts:

| Param | Notes |
|---|---|
| `search` | Case-insensitive match on client name, phone digits (spaces ignored) or submission number |
| `provinceId`, `districtId`, `communeId`, `saleGbId` | ObjectIds |
| `dateFrom`, `dateTo` | `YYYY-MM-DD`, whole days in `APP_UTC_OFFSET`, inclusive |
| `page`, `limit` | Default 1 / 20, max limit 100 |
| `sortBy`, `sortOrder` | `submittedAt` (default) \| `clientName` \| `submissionNo`, `desc` (default) \| `asc` |

Pagination runs in MongoDB (`skip`/`limit` plus `countDocuments`), with `_id` as a tiebreaker so page boundaries stay stable.

`GET /api/admin/submissions/:id` returns full details. Each file has a presigned `url` valid for `FILE_URL_EXPIRY_SECONDS`. These URLs are generated per request and never stored. The bucket itself is private.

### Excel export

`GET /api/admin/submissions/export` takes the same filters and sort as the list (no pagination) and downloads `client-submissions-YYYY-MM-DD.xlsx` with the columns Submission No, Client Name, Phone, Province, District, Commune, Sale GB and Submitted At. Rows stream from a MongoDB cursor into ExcelJS's streaming writer, so memory use stays flat for large exports. Internal fields (IDs, object keys, idempotency keys) are never exported.

## Database collections and indexes

| Collection | Purpose | Important indexes |
|---|---|---|
| `admins` | Admin accounts | `email` unique (login lookup, no duplicate admins) |
| `revokedtokens` | Logged-out JWT IDs | `jti` unique; TTL on `expiresAt` so entries delete themselves |
| `provinces` | Level 1 | `code` unique (import key); `{isActive, code}` for the public dropdown |
| `districts` | Level 2, `provinceId` ref | `{provinceId, code}` unique; `{provinceId, isActive, code}` for the cascade query |
| `communes` | Level 3, `districtId` + `provinceId` refs | `{districtId, code}` unique; `{districtId, isActive, code}` for the cascade query |
| `sales` | Sale GB | `code` unique when present (partial); `{isActive, name}` for the public dropdown |
| `submissions` | Client submissions with name snapshots and file metadata | see below |

Submission indexes:

- `submissionNo` (unique): lookup and uniqueness guarantee.
- `idempotencyKey` (unique, partial): duplicate-request protection. Documents without a key are not indexed.
- `{submittedAt: -1, _id: -1}`: the default list order and date-range filters.
- `{provinceId, submittedAt}`, `{districtId, submittedAt}`, `{communeId, submittedAt}`, `{saleGbId, submittedAt}`: each dropdown filter combined with the default sort and date range.
- `phone`: phone lookups.

Free-text search on names uses a regex, which scans the matching filter range. That's fine at this scale. If submissions reach the millions, add a dedicated search solution.

## Security notes

- Helmet headers, CORS limited to `CORS_ORIGIN`, and JSON/urlencoded bodies capped at 1 MB.
- Rate limit: failed logins per IP only; public routes and outlet submissions are not rate limited. Login responses take the same time for unknown emails and wrong passwords.
- The limiter's in-memory store is per process. Everything else is stateless, so to run several instances, switch the limiter to a shared store (e.g. MongoDB).
- Logs contain method, URL, status and timing only: no bodies, tokens or secrets. Stack traces are only returned outside production.
- MongoDB and MinIO ports are bound to `127.0.0.1`.

## Testing

```bash
docker compose up -d
npm test
```

The tests use the running Docker services but a separate database (`client_management_test`) and bucket (`client-documents-test`), which they reset at the start of each run. Your development data is not touched. They cover authentication and logout revocation, phone and name validation, location hierarchy checks, file type/size/count limits including spoofed content, public submission with snapshots and stored files, idempotent replays and races (including orphan cleanup), 25 concurrent submissions, admin filters, search, date ranges, pagination, sorting, details with presigned URLs, Excel export filters, Sale GB management, and the location importer (layouts, inheritance, conflicts, re-import).

## Project structure

```text
src/
├── app.js, server.js          # Express setup; startup and graceful shutdown
├── config/                    # env (Zod), database (pool), minio
├── middleware/                # auth, validate, upload, rateLimit, error, notFound
├── modules/
│   ├── auth/                  # admin model, revoked tokens, login/me/logout
│   ├── location/              # province/district/commune models + public API
│   ├── sale/                  # Sale GB model, public + admin API
│   ├── submission/            # model, validation, create/list/details
│   ├── upload/                # content-type detection, MinIO upload with compensation
│   └── export/                # streaming Excel export
├── routes/                    # /api/health, /api/public, /api/admin, /api/docs
├── scripts/                   # seed-admin, seed-sales, import-locations
├── docs/swagger.js            # OpenAPI spec
└── utils/                     # ApiError, asyncHandler, response, pagination, validators, date
tests/                         # node:test integration tests
data/                          # location.xlsx (you provide), sales.example.json
```
