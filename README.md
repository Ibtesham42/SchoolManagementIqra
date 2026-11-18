# School Website + School Management ERP

A CMS-driven public school website with an AI information chatbot, plus a full school ERP: admissions, students, staff, payroll, attendance, fees, transport, academics, library, inventory, import/export and document generation.

> **Status (2026-11-08):** Phase 1 (Security and Core Foundation) is built and CI is green on Ubuntu; it is **blocked on database verification** until the Neon `development`/`test` branches are configured. Phase 2 has not started. Roadmap: [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md) · progress: [docs/DEVELOPMENT_PROGRESS.md](docs/DEVELOPMENT_PROGRESS.md) · UI audit: [docs/LOCAL_UI_AUDIT.md](docs/LOCAL_UI_AUDIT.md).
>
> Runs entirely on free tiers during development — see [docs/FREE_TIER.md](docs/FREE_TIER.md).

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui (Radix) · PostgreSQL (Neon) + pgvector · Prisma 7 · Zod · Vitest · Playwright + axe. Planned for later phases: Recharts (dashboards), @react-pdf/renderer (documents).

## Documentation

| Doc | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Rules for anyone (human or AI) changing the code |
| [DEVELOPMENT_ROADMAP](docs/DEVELOPMENT_ROADMAP.md) | Current phases 0–10, status, completion criteria |
| [PROJECT_PLAN](docs/PROJECT_PLAN.md) | Original phase plan (historical) and open questions |
| [LOCAL_UI_AUDIT](docs/LOCAL_UI_AUDIT.md) | Latest browser audit: what is verified, pending or missing |
| [SYSTEM_ARCHITECTURE](docs/SYSTEM_ARCHITECTURE.md) | Architecture & decision records |
| [DATABASE_SCHEMA](docs/DATABASE_SCHEMA.md) / [RELATIONSHIPS](docs/DATABASE_RELATIONSHIPS.md) | Data model |
| [AUTHENTICATION_AND_RBAC](docs/AUTHENTICATION_AND_RBAC.md) | Roles, permissions, scopes |
| [SECURITY](docs/SECURITY.md) | Controls & data protection |
| [API_DOCUMENTATION](docs/API_DOCUMENTATION.md) | API conventions & endpoints |
| [UI_UX_GUIDELINES](docs/UI_UX_GUIDELINES.md) | Mobile-first design rules |
| [NEON_SETUP_GUIDE](docs/NEON_SETUP_GUIDE.md) · [ENVIRONMENT_VARIABLES](docs/ENVIRONMENT_VARIABLES.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [BACKUP_AND_RECOVERY](docs/BACKUP_AND_RECOVERY.md) | Operations |
| [TESTING_STRATEGY](docs/TESTING_STRATEGY.md) | Test layers & mandatory cases |
| [ROADMAP](docs/ROADMAP.md) · [CHANGELOG](docs/CHANGELOG.md) · [KNOWN_ISSUES](docs/KNOWN_ISSUES.md) | Tracking |

## Getting started

Requirements: Node.js 26 LTS and a free [Neon](https://neon.com) account (no local PostgreSQL or Docker needed).

1. `npm install`
2. Set up Neon (branches, `.env`, `.env.test`, keys, `env:check`, migration review) — follow **[docs/NEON_SETUP_GUIDE.md](docs/NEON_SETUP_GUIDE.md)** step by step.
3. Copy `.env.example` to `.env` and fill it in (see [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md)).
4. `npm run db:deploy` — apply migrations to the development branch.
5. `npm run db:check` — verify connection, pgvector, tables and storage budget.
6. `npm run db:seed` — roles, permissions, placeholder settings, first Super Admin.
7. `npm run dev` → http://localhost:3000/login

Quality gate: `npm run lint && npm run typecheck && npm test` (`npm test` is unit-only and never touches a database; integration tests run only via `npm run test:integration`).

## Offline preview (no database)

The public and sign-in screens can be previewed without Neon. Pass development-only values to the dev process (no `.env` file needed) — every value still passes the startup validation:

```bash
key(){ node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"; }
SESSION_SECRET=$(key) DATA_ENCRYPTION_KEY=$(key) DATA_HMAC_KEY=$(key) \
APP_URL=http://localhost:3000 RATE_LIMIT_DRIVER=memory \
DATABASE_URL=postgresql://offline:offline@127.0.0.1:1/dev_placeholder_no_database \
DIRECT_URL=postgresql://offline:offline@127.0.0.1:1/dev_placeholder_no_database \
npm run dev
```

The terminal will show `prisma:error … Can't reach database server` lines when a page asks for the school name — expected in this mode; the page falls back to "School". Requires Node 26 (`node -v`).

Works: `/`, `/login` (sign-in fails politely), `/forgot-password`, `/reset-password`, 404, `/api/health`. Needs a database: everything under `/erp` (it redirects to `/login`). See [docs/LOCAL_UI_AUDIT.md](docs/LOCAL_UI_AUDIT.md).

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, every pull request into `main`, and on demand. On Ubuntu with Node 26 it runs, in order and stopping at the first failure:

| Step | Command |
|---|---|
| Install (from `package-lock.json`) | `npm ci` |
| TypeScript | `npm run typecheck` |
| ESLint (incl. layer rules, unsafe-SQL ban) | `npm run lint` |
| Architecture (circular imports, layer boundaries) | `npm run check:deps` |
| Unit tests | `npm run test:unit` |
| Production dependency audit | `npm audit --omit=dev --audit-level=low` |
| Production build | `npm run build` |

It needs **no secrets, no `.env` and no database**: it never connects to Neon, runs no migrations or seeds, skips the database-dependent integration/e2e suites, and never deploys. Permissions are read-only (`contents: read`); a newer push to the same branch or pull request cancels the older run.

**Enable it:** push the repository to GitHub → **Settings → Actions → General** → *Actions permissions*: "Allow all actions and reusable workflows" (or allow `actions/checkout` and `actions/setup-node`) → Save. Leave *Workflow permissions* at "Read repository contents". The first push to `main` (or the **Actions → CI → Run workflow** button) starts a run.

**Latest run:** CI run #1 on `ubuntu-latest` passed every step (2026-11-08, commit `270f8fe`).

**Inspect a failure:** **Actions** tab → **CI** → the failed run → job *Typecheck, lint, architecture, unit tests, audit, build* → expand the red step; the log shows the failing file/test. Reproduce locally with the same command from the table (e.g. `npm run test:unit`). To block merging on failures, add a branch protection rule for `main` requiring the "CI" check.
