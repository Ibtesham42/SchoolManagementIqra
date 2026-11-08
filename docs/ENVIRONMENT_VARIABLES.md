# Environment Variables

Names only — **never commit values**. `.env.example` mirrors this list with empty values. `.env`, `.env.local`, `.env.*.local` are git-ignored. Validated at startup by `src/lib/env.ts` (Zod); the app refuses to boot if a required variable is missing or malformed.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string (host contains `-pooler`), used by the app at runtime |
| `DIRECT_URL` | yes | Neon **direct** (non-pooled) connection string, used by Prisma CLI for migrations (`prisma.config.ts`) |
| `TEST_DATABASE_URL` | for integration tests | Connection string of a separate Neon **`test`** branch. Tests use only this URL and are skipped without it — they never touch development or production data |
| `DB_CONNECT_TIMEOUT_MS` | optional | Fail fast when the DB is unreachable; default 10000 (allows a Neon cold start) |
| `TRUSTED_PROXY_HOPS` | optional | Which `X-Forwarded-For` entry (from the right) is the real client IP; default 1 (one reverse proxy). Set 0 if the app is directly exposed |
| `E2E_BASE_URL`, `E2E_DATABASE_URL` | e2e only | Server under test and its **development/test** DB (global setup creates disposable `e2e-*` users; refuses URLs containing "prod") |
| `E2E_DEGRADED_BASE_URL` | e2e only | Second server instance with an unreachable DB, for the degraded-behaviour suite |
| `E2E_SEED_ADMIN_USERNAME`, `E2E_SEED_ADMIN_PASSWORD` | e2e only | Seeded Super Admin credentials for the seeded-login test |
| `DB_POOL_MAX` | optional | App-side pool size per instance, default 5 (Neon Free has limited connections) |
| `APP_URL` | yes | Canonical origin, used for Origin checks, QR verification links, emails |
| `SESSION_SECRET` | yes | 32+ byte random; used for HMAC of visitor/chat ids and cookie signing |
| `DATA_ENCRYPTION_KEY` | yes | 32-byte base64 key for AES-256-GCM sensitive fields |
| `DATA_ENCRYPTION_KEY_VERSION` | yes | Integer; enables key rotation |
| `DATA_HMAC_KEY` | yes | 32-byte base64 key for lookup hashes (Aadhaar dedupe) |
| `PRIVATE_STORAGE_DRIVER` | yes | `local` (default; encrypted files on disk) or `s3` (any S3-compatible bucket; files encrypted by the app before upload) |
| `PRIVATE_STORAGE_LOCAL_DIR` | local | Absolute path **outside** the project's `public/` folder |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | s3 | Private bucket only — never public-read |
| `PUBLIC_MEDIA_DRIVER` | yes | `local` (default) or `cloudinary` — **public CMS media only** |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | cloudinary | Cloudinary Free account; server-side signed uploads |
| `AI_PROVIDER` | optional | `none` (default: FAQ + keyword search, no external calls) \| `openai-compatible` \| `anthropic` |
| `AI_MODEL` | if AI | Model id for the chosen provider |
| `AI_BASE_URL`, `AI_API_KEY` | if openai-compatible | e.g. a free-tier endpoint — review its terms first (docs/FREE_TIER.md) |
| `ANTHROPIC_API_KEY` | if anthropic | Paid API — not used under the free-only policy |
| `AI_DAILY_REQUEST_LIMIT` | optional | Hard daily cap on LLM calls; default **0** (disabled) |
| `EMBEDDING_PROVIDER` | optional | `none` (FTS only, default) \| `local` (in-process model, no API) |
| `PAYMENT_GATEWAY` | optional | `none` (default) \| `razorpay` (Phase 8; gateway fees are per-transaction, owner decision) |
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
