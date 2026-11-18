---
name: deployment-ci
description: Use when changing the GitHub Actions workflows, investigating a CI failure, preparing a release or deployment plan, choosing hosting, or adjusting scheduled jobs. Covers the offline CI gate, free-tier hosting constraints and the approval rules for anything production-facing.
---

# Deployment & CI/CD

## CI (`.github/workflows/ci.yml`)
Push/PR to `main` + manual. Steps (must stay in this order and offline): `npm ci` → `npm run typecheck` → `npm run lint` → `npm run check:deps` → `npm run test:unit` → `npm audit --omit=dev --audit-level=low` → `npm run build`. Ubuntu, Node 26, npm cache, 20-min timeout, `contents: read`, actions pinned to commit SHAs, `persist-credentials: false`, concurrency cancels outdated runs.
- Placeholder `DIRECT_URL` exists only because `prisma generate` loads `prisma.config.ts`; nothing connects to it.
- Never add secrets, DB connections, migrations, seeds or deploy steps to CI. DB-backed tests need a separate, owner-approved design (KI-030).
- Fixing a failure: open the failed step log, reproduce with the same npm command locally, fix the cause (never `continue-on-error`, never weaken a check).
- Updating an action: resolve the new tag's commit SHA (`git ls-remote --tags`), pin it with a `# vX.Y.Z` comment.

## Scheduled jobs
`.github/workflows/cleanup.yml` → `POST /api/cron/cleanup` with `CRON_SECRET`; skips itself until repository secrets `APP_URL` + `CRON_SECRET` exist. Daily at most (each call wakes Neon).

## Deployment (Roadmap Phase 10; docs/DEPLOYMENT.md, docs/FREE_TIER.md)
- Build: `next build` → `.next/standalone` → `node server.js` (Node 26); copy `.next/static` alongside.
- Host must permit institutional use (Vercel Hobby does not). `after()` needs post-response execution support on serverless hosts.
- Production `APP_URL` must be HTTPS (boot refuses otherwise); env vars set in the host's secret store, never in files in the repo.
- Release: CI green → reviewed migration `prisma migrate deploy` (owner-approved, fresh backup) → deploy → smoke test (`/api/health`, login, one read per module).
- **Every deployment, production migration and secret change requires explicit owner approval.** Agents prepare runbooks; they don't execute them.
