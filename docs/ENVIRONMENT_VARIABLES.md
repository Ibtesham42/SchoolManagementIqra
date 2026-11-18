# Environment Variables

Names only — **never commit values**. `.env.example` mirrors this list with empty values. `.env`, `.env.local`, `.env.*.local` are git-ignored. Validated at startup by `src/lib/env.ts` (Zod); the app refuses to boot if a required variable is missing or malformed.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string (host contains `-pooler`), used by the app at runtime |
| `DIRECT_URL` | yes | Neon **direct** (non-pooled) connection string, used by Prisma CLI for migrations (`prisma.config.ts`) |
| `TEST_DATABASE_URL` | for integration tests | Connection string of a separate Neon **`test`** branch. Tests use only this URL and are skipped without it — they never touch development or production data |
| `TEST_TARGET_BRANCH_ID`, `TEST_TARGET_ENDPOINT_ID` | **required for integration tests** (S-05, 2026-11-10) | The Neon **test** branch id (`br-…`) and endpoint id (`ep-…`). Not secrets. `npm run test:integration` refuses to start unless `TEST_DATABASE_URL`'s host is this endpoint, it is neither development (`SEED_TARGET_*`) nor in `FORBIDDEN_*`, no database variable is set in the shell, and the live server (read-only) reports exactly this branch/endpoint |
| `E2E_TARGET_BRANCH_ID`, `E2E_TARGET_ENDPOINT_ID` | e2e only (S-06) | Allow-list for the database behind `E2E_DATABASE_URL` (development or test). Not secrets |
| `DB_CONNECT_TIMEOUT_MS` | optional | Fail fast when the DB is unreachable; default 10000 (allows a Neon cold start) |
| `TRUSTED_PROXY_HOPS` | optional | Which `X-Forwarded-For` entry (from the right) is the real client IP; default 1 (one reverse proxy). Set 0 if the app is directly exposed |
| `E2E_BASE_URL`, `E2E_DATABASE_URL` | e2e only | Server under test and its **development/test** DB (shell variables). Global setup creates disposable `e2e-*` users only after the S-06 guard: `E2E_TARGET_BRANCH_ID` / `E2E_TARGET_ENDPOINT_ID` (in `.env`) must name that branch/endpoint, it must not be in `FORBIDDEN_*`, and the live server must report exactly that identity; accounts are created under the Super Admin lock with audit rows and removed by global teardown |
| `E2E_DEGRADED_BASE_URL` | e2e only | Second server instance with an unreachable DB, for the degraded-behaviour suite |
| `E2E_SEED_ADMIN_USERNAME`, `E2E_SEED_ADMIN_PASSWORD` | e2e only | Seeded Super Admin credentials for the seeded-login test |
| `DB_POOL_MAX` | optional | App-side pool size per instance, default 5 (Neon Free has limited connections) |
| `APP_URL` | yes | Canonical origin, used for Origin checks, QR verification links, emails |
| `SESSION_SECRET` | yes | 32+ byte random; used for HMAC of visitor/chat ids and cookie signing |
| `DATA_ENCRYPTION_KEY` | yes | 32-byte base64 key for AES-256-GCM sensitive fields |
| `DATA_ENCRYPTION_KEY_VERSION` | yes | Integer; enables key rotation |
| `DATA_HMAC_KEY` | yes | 32-byte base64 key for lookup hashes (Aadhaar dedupe). **Not** used for document verification |
| `FORBIDDEN_BRANCH_IDS` | `env:check` | Comma-separated Neon branch id(s) (`br-…`, e.g. production) that every check refuses after a read-only identity query. Not a secret. Required for the connected `env:check` |
| `FORBIDDEN_ENDPOINT_IDS` | `env:check` | Comma-separated Neon endpoint id(s) (`ep-…`, e.g. production's) refused **from the URL host name before any connection is attempted** — covers `.env` and `.env.test`. Not a secret. Required for the connected `env:check`; written by `npm run setup:env` |
| `SEED_TARGET_BRANCH_ID`, `SEED_TARGET_ENDPOINT_ID` | `db:seed` | Allow-list for `npm run db:seed` (ADR-032): the only Neon branch (`br-…`) and endpoint (`ep-…`) the seed may write to — the **development** branch. Not secrets. Must not be forbidden or the test endpoint (checked by `env:check`). Written by `npm run setup:env` |
| `DRILL_TARGET_BRANCH_ID`, `DRILL_TARGET_ENDPOINT_ID` (+ `DATABASE_URL`, `DIRECT_URL`) | drill | Live **only in `.env.restore.local`** (git-ignored, on Claude Code's deny list), written by `npm run drill:env -- --project-id <id> --branch <drill branch>`. Allow-list for `npm run backup:drill`: the only branch/endpoint it may restore into — a disposable child of development. Delete the file after the drill |
| `DOCUMENT_VERIFICATION_KEY` | yes | 32-byte base64 key used **only** to hash document verification codes (ADR-031). Must differ from `DATA_ENCRYPTION_KEY` and `DATA_HMAC_KEY` (validated at start-up and by `env:check`). If lost, documents issued under it can no longer be verified — keep a copy in the password manager |
| `DOCUMENT_VERIFICATION_KEY_VERSION` | no (default 1) | Integer 1–32767; stored on every issued document |
| `DOCUMENT_VERIFICATION_KEY_V<n>` | after rotation | Rotated-out key for version `<n>` so older documents keep verifying. Must be 32 bytes, must not equal the current key, and `<n>` must not be the current version. Keep for as long as documents of that version should verify |
| `PRIVATE_STORAGE_DRIVER` | yes | `local` (default; files on disk, PRIVATE ones encrypted by the app) or `s3` (any S3-compatible bucket; files encrypted by the app before upload). **`s3` is not implemented yet** — selecting it fails at first upload/download with a clear error (KI-034) |
| `PRIVATE_STORAGE_LOCAL_DIR` | local | **Required** when the driver is `local` (checked by `npm run env:check:offline`) (uploads/downloads fail without it). Absolute path **outside** the project folder and `public/`; holds `public/` (logo) and `private/` (encrypted) sub-trees. Back it up with the database (BACKUP_AND_RECOVERY) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | s3 | Private bucket only — never public-read |
| `PUBLIC_MEDIA_DRIVER` | yes | `local` (default) or `cloudinary` — **public CMS media only** |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | cloudinary | Cloudinary Free account; server-side signed uploads |
| `AI_PROVIDER` | optional | `none` (default: FAQ + keyword search, no external calls) \| `openai-compatible` \| `anthropic` |
| `AI_MODEL` | if AI | Model id for the chosen provider |
| `AI_BASE_URL`, `AI_API_KEY` | if openai-compatible | e.g. a free-tier endpoint — review its terms first (docs/FREE_TIER.md) |
| `ANTHROPIC_API_KEY` | if anthropic | Paid API — not used under the free-only policy |
| `AI_DAILY_REQUEST_LIMIT` | optional | Hard daily cap on LLM calls; default **0** (disabled) |
| `EMBEDDING_PROVIDER` | optional | `none` (FTS only, default) \| `local` (in-process model, no API) |
| `PAYMENT_GATEWAY` | optional | `none` (default) \| `razorpay` (Roadmap Phase 5; gateway fees are per-transaction, owner decision) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | if razorpay | |
| `EMAIL_PROVIDER` | yes | `log` (default: dev preview, emails printed to server log / dev mailbox) \| `resend` \| `none` |
| `EMAIL_FROM` | if resend | Sender address on a domain verified in Resend |
| `RESEND_API_KEY` | if resend | Resend Free (3,000/month, 100/day) |
| `USAGE_CAP_EMAIL_SENT`, `USAGE_CAP_MEDIA_UPLOADS` | optional | Override daily free-tier caps (defaults 90 and 200) |
| `SMS_PROVIDER` | optional | `none` (default). SMS has no genuinely free provider in India; deferred (ROADMAP). |
| `RATE_LIMIT_DRIVER` | yes | `postgres` (default, works across instances, no Redis needed) \| `memory` (single-process dev) |
| `CRON_SECRET` | prod | Bearer token for `POST /api/cron/cleanup` (≥ 32 random characters; the endpoint refuses all calls when unset). Same value goes into the scheduler (e.g. GitHub Actions secret) |
| `LOG_LEVEL` | optional | default `info` |
| `SEED_SUPERADMIN_USERNAME`, `SEED_SUPERADMIN_PASSWORD` | seed only | Initial Super Admin; forced password change on first login |

Key rotation: set the new key as `DATA_ENCRYPTION_KEY`, bump `DATA_ENCRYPTION_KEY_VERSION`, and keep the previous key as `DATA_ENCRYPTION_KEY_V<old version>` until re-encryption finishes.

Generate keys: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (run once per key; paste into your local `.env`, never into chat, docs or commits).

Separate values per environment: the **development** Neon branch and the **production** Neon branch have different connection strings, and production must use different encryption/HMAC keys than development.

School-specific values (name, address, fees, timings) are **not** env vars — they are settings in the database.

## Rotating `DOCUMENT_VERIFICATION_KEY` (owner action, per installation)

1. Copy the current value of `DOCUMENT_VERIFICATION_KEY` into a new variable `DOCUMENT_VERIFICATION_KEY_V<current version>`.
2. Generate a new 32-byte key (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) and set it as `DOCUMENT_VERIFICATION_KEY`.
3. Increment `DOCUMENT_VERIFICATION_KEY_VERSION`.
4. Run `npm run env:check`, then restart. Both use the same validator (`checkKeySeparation` in `src/lib/env.ts`) and reject: a key that isn't 32 bytes, a key reused across `DATA_ENCRYPTION_KEY` / `DATA_HMAC_KEY` / `DOCUMENT_VERIFICATION_KEY`, an old key equal to the current one, an old key numbered with the current version, and any misspelt name such as `…_V01` or `…_V1A` (only `DOCUMENT_VERIFICATION_KEY_V<1–32767>` without leading zeros is ever loaded).

New documents use the new version; earlier documents keep verifying with their old key. Removing a `DOCUMENT_VERIFICATION_KEY_V<n>` makes every document of version `<n>` report "not found" — only do it when those documents should no longer verify. Never put key values in docs, tickets, chat or commits.
