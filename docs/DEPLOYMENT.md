# Deployment

Status: development environment defined (Phase 1). Production steps will be verified and recorded in Phase 15.
Free-tier limits and hosting terms: **docs/FREE_TIER.md** (read it before choosing a host).

## Neon setup (one-time, done by the project owner)

1. Sign up at https://neon.com with **no payment method**. Create a project (Postgres 17, region nearest the school, e.g. AWS ap-south-1 Mumbai if offered).
2. The project's default branch is renamed or used as **`production`**. Create two child branches from it (Branches → New branch), both while production is still empty so no real data is ever copied:
   - **`development`** — local development; `prisma migrate dev` and the seed only ever target this branch.
   - **`test`** — integration tests only (`TEST_DATABASE_URL`); tests create and delete their own rows.
3. For each branch, open **Connect**, and copy two strings for role/database:
   - **Pooled** (host contains `-pooler`) → `DATABASE_URL`
   - **Direct** (toggle "Connection pooling" off) → `DIRECT_URL`
   Both should end with `?sslmode=require` (add `&channel_binding=require` if Neon shows it).
4. Put the **development** strings (and the **test** branch pooled string as `TEST_DATABASE_URL`) in your local `.env` only. Production strings go only into the production host's secret settings — never into the local `.env`. Production is never seeded with development sample data; it receives only migrations and, at go-live, the first Super Admin.
5. pgvector is enabled by the first migration (`CREATE EXTENSION IF NOT EXISTS vector`) — no console action needed.
6. Verify: `npm run db:deploy && npm run db:check`.

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
