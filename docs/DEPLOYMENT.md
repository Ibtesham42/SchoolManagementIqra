# Deployment

Status (2026-11-08): **not deployed anywhere.** CI (offline gate) is green on GitHub. Neon is not yet configured; the production host is not chosen (FREE_TIER.md). Production steps will be verified in Roadmap Phase 10 (DEVELOPMENT_ROADMAP.md); every deployment needs explicit owner approval.
Free-tier limits and hosting terms: **docs/FREE_TIER.md** (read it before choosing a host).

## Neon setup (one-time, done by the project owner)

**Follow [NEON_SETUP_GUIDE.md](NEON_SETUP_GUIDE.md)** — the verified, step-by-step procedure (approved 2026-11-08). Summary:

1. Free project, **no payment method**. Default branch = **`production`** (stays empty until go-live). Reset the exposed `neondb_owner` password on every branch that predates the reset.
2. Child branches **`development`** (local work, migrations reviewed first, seed) and **`test`** (integration tests only).
3. Connection strings from **Connect** (Branch / Database `neondb` / Role / pooling toggle): pooled (`-pooler`) → `DATABASE_URL`, direct → `DIRECT_URL`; use `sslmode=verify-full`. Neon currently runs PostgreSQL 18.
4. Local files: `.env` (development pooled + direct, test pooled as `TEST_DATABASE_URL`, three keys, seed credentials) and `.env.test` (test pooled + direct) — both git-ignored, edited only by the owner. Production strings never go in local files.
5. `npm run env:check` with `FORBIDDEN_BRANCH_IDS=<production branch id>` must pass before anything else.
6. Migrations: review checklist → owner approval → `development` → `test` (via `DOTENV_PATH=.env.test` inside `try/finally`) → `db:check`; seed development only. pgvector is enabled by the first migration.

Branch rules: never run `migrate dev`/`reset` against `production`; production only receives `prisma migrate deploy` of committed migrations. Neon Free allows 10 branches — delete short-lived preview branches after use.

## Production topology (portable)

| Component | Free-tier option | Notes |
|---|---|---|
| App | Host whose terms allow institutional use (see FREE_TIER.md). The build is `next build` → `.next/standalone` → `node server.js` (Node 26) | **Not** Vercel Hobby (non-commercial personal use only) |
| Database | Neon Free `production` branch | Scale-to-zero adds ~0.5–1 s to the first request after 5 min idle |
| Private files | Encrypted local disk on the app server, or private S3-compatible bucket | App-side encryption; downloads only through the authorized route |
| Public media | Cloudinary Free | Logos, banners, gallery |
| Email | Resend Free (or `log`) | 100/day cap |
| Cron | `.github/workflows/cleanup.yml` (free GitHub Actions schedule, daily) calls `POST /api/cron/cleanup` with `CRON_SECRET`; or host cron running `npm run cleanup` | expired sessions, rate-limit buckets, old reset tokens, old usage counters |
| Monitoring | Free uptime checker on `/api/health` (liveness, no DB). Use `?deep=1` with `CRON_SECRET` only from trusted schedulers, at most hourly — every deep check wakes Neon compute | |
| Background work | Password-reset processing uses Next.js `after()`; works on the standalone Node server. On serverless hosts confirm the platform supports post-response work (`waitUntil`) | |

## Release procedure

1. CI (`.github/workflows/ci.yml`, must be green): `npm ci` → typecheck → lint → check:deps → unit tests → production audit → build. Integration and e2e run separately against the Neon `test` branch until a disposable CI database exists (KNOWN_ISSUES KI-030).
2. `prisma migrate deploy` against `DIRECT_URL` **before** promoting the new build. Migrations must be backward compatible with the previous release (expand → migrate → contract).
3. Promote. Smoke test: login, public homepage, one read per module.
4. Rollback: re-promote previous build; migrations are forward-only (write a fix-forward migration).

## Environments

| Env | DB | Data |
|---|---|---|
| local | Neon `development` branch | synthetic seed |
| preview (optional) | short-lived Neon branch from `development` | synthetic seed |
| production | Neon `production` branch | real — never copied to lower environments without anonymisation |

> **`sharp` in the standalone output (KI-056):** `next.config.ts` traces `node_modules/@img/**` for `/api/v1/**` because Next.js doesn't copy the libvips shared libraries `sharp` loads. Build on the **same OS/architecture** as the host (npm installs only that platform's `@img/*` packages) and check after every build: `node -e "require('sharp')"` run with the working directory `.next/standalone` must succeed.
