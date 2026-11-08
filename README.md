# School Website + School Management ERP

A CMS-driven public school website with an AI information chatbot, plus a full school ERP: admissions, students, staff, payroll, attendance, fees, transport, academics, library, inventory, import/export and document generation.

> **Status:** Phase 1 in progress — foundation (auth, RBAC, schema) built; database connection pending. See [docs/DEVELOPMENT_PROGRESS.md](docs/DEVELOPMENT_PROGRESS.md).
>
> Runs entirely on free tiers during development — see [docs/FREE_TIER.md](docs/FREE_TIER.md).

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · PostgreSQL + pgvector · Prisma · React Hook Form + Zod · Recharts · @react-pdf/renderer · Vitest · Playwright

## Documentation

| Doc | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Rules for anyone (human or AI) changing the code |
| [PROJECT_PLAN](docs/PROJECT_PLAN.md) | Phases, exit criteria, open questions |
| [SYSTEM_ARCHITECTURE](docs/SYSTEM_ARCHITECTURE.md) | Architecture & decision records |
| [DATABASE_SCHEMA](docs/DATABASE_SCHEMA.md) / [RELATIONSHIPS](docs/DATABASE_RELATIONSHIPS.md) | Data model |
| [AUTHENTICATION_AND_RBAC](docs/AUTHENTICATION_AND_RBAC.md) | Roles, permissions, scopes |
| [SECURITY](docs/SECURITY.md) | Controls & data protection |
| [API_DOCUMENTATION](docs/API_DOCUMENTATION.md) | API conventions & endpoints |
| [UI_UX_GUIDELINES](docs/UI_UX_GUIDELINES.md) | Mobile-first design rules |
| [ENVIRONMENT_VARIABLES](docs/ENVIRONMENT_VARIABLES.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [BACKUP_AND_RECOVERY](docs/BACKUP_AND_RECOVERY.md) | Operations |
| [TESTING_STRATEGY](docs/TESTING_STRATEGY.md) | Test layers & mandatory cases |
| [ROADMAP](docs/ROADMAP.md) · [CHANGELOG](docs/CHANGELOG.md) · [KNOWN_ISSUES](docs/KNOWN_ISSUES.md) | Tracking |

## Getting started

Requirements: Node.js 26 LTS and a free [Neon](https://neon.com) account (no local PostgreSQL or Docker needed).

1. `npm install`
2. Create the Neon project and branches — [docs/DEPLOYMENT.md → Neon setup](docs/DEPLOYMENT.md).
3. Copy `.env.example` to `.env` and fill it in (see [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md)).
4. `npm run db:deploy` — apply migrations to the development branch.
5. `npm run db:check` — verify connection, pgvector, tables and storage budget.
6. `npm run db:seed` — roles, permissions, placeholder settings, first Super Admin.
7. `npm run dev` → http://localhost:3000/login

Quality gate: `npm run lint && npm run typecheck && npm test`.

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

**Inspect a failure:** **Actions** tab → **CI** → the failed run → job *Typecheck, lint, architecture, unit tests, audit, build* → expand the red step; the log shows the failing file/test. Reproduce locally with the same command from the table (e.g. `npm run test:unit`). To block merging on failures, add a branch protection rule for `main` requiring the "CI" check.
