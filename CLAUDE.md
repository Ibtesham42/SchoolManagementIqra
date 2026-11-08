# CLAUDE.md — School Website + School ERP

Read this file fully before changing anything. Detailed rules live in `.claude/rules/`, domain workflows in `.claude/skills/`, and the authoritative design in the `docs/` files listed below.

## Purpose

One deployable product for **one school**:

1. **Public website** (CMS-driven, no hard-coded school content) with an AI information chatbot.
2. **Private ERP** — admissions, students, staff, payroll, attendance, fees, transport, academics, library, inventory, import/export, documents, notifications.

This is a real product used for daily administration. No placeholder buttons, no fake data paths, no features marked done without tests.

## Stack (see SYSTEM_ARCHITECTURE.md for rationale)

| Layer | Choice |
|---|---|
| Runtime | **Node.js 26 LTS** (`engines: >=26.0.0`, `.nvmrc`). npm 11 install-script allowlist in `package.json → allowScripts` (only `prisma`, `@prisma/engines`, `esbuild`); review before approving any new one |
| App | Next.js 16 App Router, React 19, TypeScript `strict`, `output: "standalone"` (portable) |
| UI | Tailwind CSS v4, shadcn/ui (Radix primitives), lucide icons, Recharts |
| Forms | React Hook Form + Zod (the same Zod schema validates on the server) |
| DB | **Neon Postgres Free** with `pgvector`; Prisma 7 + `@prisma/adapter-pg`. Runtime → pooled `DATABASE_URL`; CLI/migrations → `DIRECT_URL` (`prisma.config.ts`) |
| Auth | Custom DB-backed sessions, Argon2id (`@node-rs/argon2`) |
| Files | Public media → Cloudinary Free / local. Private documents → local or S3-compatible, **app-encrypted**, served only via authorized route |
| Email | Provider interface: `log` (dev preview, default) / Resend Free |
| PDF | `@react-pdf/renderer` (server-side) |
| Import/Export | `exceljs`, `papaparse` |
| AI | Default **no LLM**: FAQ + Postgres FTS. Optional LLM (`openai-compatible`) with hard daily cap; optional local embeddings |
| Tests | Vitest (unit + integration against real Postgres), Playwright (e2e, mobile viewports) |

### Free-only policy (ADR-016, docs/FREE_TIER.md)
- No paid APIs, plugins, hosting or subscriptions. Never add a dependency on a service that requires a payment method.
- Every external service is optional with a no-cost default; metered calls go through `lib/usage.consume()` (caps below provider limits, warning at 80 %).
- Confidential data (student records, Aadhaar, PAN, salary, bank, ID documents) is never placed in Cloudinary or any public storage.

## Folder structure

```
prisma/                 schema.prisma, migrations/, seed.ts
src/
  app/
    (public)/           public website routes (read published CMS only)
    (auth)/             login, password reset
    erp/                authenticated ERP routes (layout enforces session)
    api/v1/             REST route handlers (thin: parse → service → respond)
    api/webhooks/       payment gateway webhooks (signature-verified)
  modules/<domain>/     business logic per domain
    *.service.ts        the ONLY place that mutates domain data
    *.schemas.ts        Zod schemas (shared by forms, actions, routes, import)
    *.policy.ts         record-level access rules (scope checks)
  lib/                  cross-cutting: db, auth, rbac, audit, errors, storage,
                        pdf, sequence, money, crypto, rate-limit, logger
  chatbot/              ISOLATED: may import only lib/ai, lib/db and knowledge models
  components/ui         shadcn/ui primitives (owned code; mobile sizes + AA colours customised)
  components/erp        shared ERP blocks: TextField, FormStatus, SubmitButton, PageHeader,
                        ConfirmAction, OneTimeSecret, NotPermitted, navigation
  components/public     public website sections (Phase 2)
tests/unit|integration|e2e
docs/                   all project documentation
```

## Non-negotiable rules

1. **Authorization is server-side.** Every service function that reads or writes non-public data takes an `AuthContext` and calls `authorize(ctx, "<permission>")` plus a record-scope policy. Hiding UI is cosmetic only.
2. **Services own mutations.** Route handlers and server actions validate input with Zod, call a service, and map errors. No Prisma calls in components, pages, or route handlers.
3. **Transactions** for: admission + ID generation, roll-number finalization, fee payment + receipt, payroll run + approval, imports (per batch), stock changes (library/inventory).
4. **Sequences** (admission no., student ID, employee ID, receipt no., slip no.) come only from `lib/sequence` (row-locked counter inside the caller's transaction). Never `MAX()+1`, never generate in the client.
5. **Permanent IDs never change.** Student ID / admission number are immutable after creation. Edits never touch them.
6. **Audit everything sensitive** via `lib/audit` inside the same transaction (actor, action, entity, before/after with sensitive fields redacted).
7. **Money** is `Decimal(12,2)` in DB and `decimal.js` in code. Never JS floats for money.
8. **Academic data is session-scoped.** Enrollment, attendance, marks, fees, roll numbers all reference `academicSessionId`.
9. **Soft delete** (`deletedAt`) for people and financial/academic records. Hard delete only for drafts and ephemeral data.
10. **Sensitive data**: Aadhaar is encrypted (AES-256-GCM) + HMAC for dedupe, displayed masked. Medical info, salary, and documents require explicit permissions. Never log them. Never put them in exports without the matching `*.sensitive` permission.
11. **The chatbot never touches ERP data.** `src/chatbot/**` is lint-restricted from importing `src/modules/**`.
12. **No secrets in code, docs, memory, fixtures, or commits.** Config via env (see ENVIRONMENT_VARIABLES.md). No real student data in seeds — synthetic only.
13. **No invented school facts.** School name, logo, address, fees, dates, policies are settings/CMS data. Seeds use obviously fake placeholders ("Demo Public School").
14. **Mobile-first.** Every ERP screen must work at 360px width: tables collapse to cards, forms are single-column, touch targets ≥ 44px.
15. **Layer boundaries are enforced** (`npm run lint`, `npm run check:deps`): `lib` → nothing above it; `modules` → no `app`/`components`; `components` → no `app`/`modules`; `chatbot` → no `modules`. Fix the design, don't disable the rule.
16. **Every page renders dynamically** (nonce CSP, ADR-024). Never add `export const dynamic = "force-static"`; cache data, not pages.
17. **Changes to Super Admin membership** must call `lockSuperAdminGuard(tx)` as the first statement of the transaction (ADR-025).

## Coding conventions

- TypeScript strict, no `any` (use `unknown` + narrowing). ESLint + Prettier must pass.
- Files `kebab-case.ts`; components `PascalCase.tsx`; Prisma models `PascalCase`, fields `camelCase`, tables mapped to `snake_case`.
- Errors: throw `AppError` subclasses (`NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`); `lib/errors` maps them to HTTP. Never leak stack traces or Prisma messages to clients.
- Dates: store UTC `timestamptz`; school-local dates (attendance day, due date) as `date`. School timezone comes from settings.
- Pagination: cursor or `page/pageSize` (max 100). Never unbounded `findMany` on large tables.

## Workflow

1. Read CLAUDE.md, the relevant `.claude/rules/*`, and the relevant skill.
2. Check `docs/DEVELOPMENT_PROGRESS.md` and `docs/KNOWN_ISSUES.md`.
3. Schema change → edit `prisma/schema.prisma` → `npx prisma migrate dev --name <change>` → update `docs/DATABASE_SCHEMA.md`.
4. Implement service + schemas + policy → route/action → UI.
5. Tests: unit for pure logic, integration for services (real DB), e2e for critical flows.
6. Run `npm run lint && npm run typecheck && npm run check:deps && npm test` before claiming completion. CI (`.github/workflows/ci.yml`) runs the offline subset on every push/PR to `main`.
7. Update `docs/DEVELOPMENT_PROGRESS.md`, `docs/CHANGELOG.md`, and any doc whose content changed.

## Commands (available after Phase 1 setup)

```
npm run dev          # start dev server
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # vitest (unit + integration; integration skips without TEST_DATABASE_URL)
npm run test:unit    # unit tests only (what CI runs)
npm run check:deps   # circular imports + layer boundaries
npm run test:e2e     # playwright
npm run db:migrate   # prisma migrate dev (development branch only)
npm run db:deploy    # prisma migrate deploy (production branch)
npm run db:check     # verify connection, pgvector, migrations, tables, storage budget
npm run db:seed      # roles, permissions, placeholder settings, first Super Admin
```

Prisma 7 notes: the client is generated to `src/generated/prisma` (import from `@/generated/prisma/client`); the CLI does not read `.env` by itself — `prisma.config.ts` imports `dotenv/config`.

## Documentation index (`docs/`)

PROJECT_PLAN · FREE_TIER · SYSTEM_ARCHITECTURE · DATABASE_SCHEMA · DATABASE_RELATIONSHIPS · API_DOCUMENTATION · AUTHENTICATION_AND_RBAC · SECURITY · UI_UX_GUIDELINES · DEPLOYMENT · ENVIRONMENT_VARIABLES · TESTING_STRATEGY · DEVELOPMENT_PROGRESS · CHANGELOG · ROADMAP · KNOWN_ISSUES · BACKUP_AND_RECOVERY
