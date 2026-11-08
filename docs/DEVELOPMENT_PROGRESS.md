# Development Progress

| Phase | Status | Verified on | Notes |
|---|---|---|---|
| 0 — Analysis & architecture | Done | 2026-11-08 | Free-tier decisions added (ADR-016…021, FREE_TIER.md) |
| 1 — Setup, DB, auth, RBAC | **In progress — NOT complete.** Security/reliability review done; verified on a local PostgreSQL. Neon integration and remaining scope outstanding | 2026-11-08 (local) | See "Phase 1 review" below |
| 2–15 | Not started | — | |

## Log

### 2026-11-08 — CI workflow
- Added `.github/workflows/ci.yml` (offline gate; no secrets/DB/deploy). Actions pinned: `actions/checkout` v7.0.1 (`3d3c42e5…`), `actions/setup-node` v7.1.0 (`949feb24…`).
- Validation: YAML parsed (ci.yml + cleanup.yml); 12 structural requirement checks passed (triggers, permissions, concurrency, runner/timeout, Node 26 + cache, SHA pinning, step order, no secrets, no DB/deploy steps, no continue-on-error, no persisted credentials, scripts exist).
- Clean-checkout simulation (182 tracked-to-be files, no `.env`/`node_modules`/build output, CI env vars, Node 26.13.0 / npm 11.20.0, **Windows**): `npm ci` ✓ · typecheck ✓ · lint ✓ · check:deps ✓ · test:unit ✓ (1,263 passed, 9 files, no integration) · audit 0 vulnerabilities ✓ · build ✓.
- Committed on top of GitHub's initial commit `eb0fb1d` (no force push): project import, then this CI commit. The first GitHub Actions run is triggered by that push; its result is recorded separately once observed.

### 2026-11-08 — Offline security & architecture audit
No database contact, no migrations/seeds, no secret env files, nothing committed/deployed. Full findings table: docs/SECURITY.md → "Offline security & architecture audit".

- **Found and fixed:** 3 High (A1 account-takeover escalation by delegated admins, A2 Super Admin race under READ COMMITTED, A3 unsafe-SQL lint rule never matched), 6 Medium (A4 session lifetime growth, A5 reset token in query string, A6 reset timing enumeration, A7 missing CSP, A8 Neon compute drain via health/public pages, A9 unauthorised lib access path), 11 Low (A10–A20).
- **New tooling:** `npm run check:deps` (cycles + layer boundaries; verified against a planted cycle and a real violation), ESLint layer rules (verified with probe files).
- **Architecture:** 0 circular dependencies across 93 files / 259 imports; 0 boundary violations.

| Suite | Passed | Failed | Skipped (pending DB) |
|---|---|---|---|
| Unit | 1,263 | 0 | — |
| Integration | 0 | 0 | 20 (10 Phase 1 + 10 identity admin incl. 2 new race/takeover tests) |
| E2E (no-DB server; Desktop Chrome, Pixel 7, iPhone 14) | 42 | 0 | 33 |
| TypeScript / ESLint / check:deps / `next build` | ✓ / ✓ / ✓ / ✓ | — | — |
| `npm audit --omit=dev` | 0 vulnerabilities | — | — |

### 2026-11-08 — Phase 1 remaining features (offline)
Constraints honoured: no Neon or other database contact, no migrations/seeds, no secret env files, nothing committed/deployed, no paid services. Node 26.13.0 (portable).

**Implemented**
| # | Feature | Where |
|---|---|---|
| 1 | User management: list/search/filter/paginate, create (one-time temp password), edit name/email/roles, deactivate/reactivate, admin password reset, unlock, sign out all sessions | `modules/identity/users.service.ts`, `app/erp/users/**` |
| 2 | Roles & permissions UI: list, create, rename, full permission × scope editor, delete unused roles | `modules/identity/roles.service.ts`, `app/erp/roles/**` |
| 3 | Super Admin protection + anti-escalation + last-Super-Admin guard (row-locked) | `modules/identity/identity.policy.ts` (AUTHENTICATION_AND_RBAC §2a) |
| 4 | Password reset: forgot → email link (log/Resend) → single-use 30-min token → new password; no enumeration; ends sessions | `modules/identity/password-reset.service.ts`, `lib/email.ts`, `app/(auth)/forgot-password`, `reset-password` |
| 5 | shadcn/ui (radix-nova) integrated; all forms migrated (login, change password, account, users, roles, reset) | `components/ui/**`, `components/erp/**` |
| 6 | Scheduled cleanup: `POST /api/cron/cleanup` (bearer secret), `npm run cleanup`, free GitHub Actions workflow | `lib/maintenance.ts`, `.github/workflows/cleanup.yml` |
| 7 | UI: active-state sidebar + bottom nav, My account page, dashboard quick actions, "not permitted" screen, confirm dialogs, 44 px mobile controls, AA-contrast error colour, system fonts | — |
| 8 | Tests: policy, schemas, email, cron auth, temp passwords, error mapping (unit); identity admin flows (integration, pending); auth-pages + admin specs (e2e) | `tests/**` |
| 9 | Review fixes: build-time prerender of forgot-password (school name frozen) → dynamic; destructive colour failed WCAG AA (4.49:1) → red-700; shadcn CLI in prod deps (6 advisories) → devDependencies; React 19 purity/effect lint errors; label-for on non-control; unassignable roles now disabled in UI via the same policy | — |

**Test results**
| Suite | Passed | Failed | Skipped (pending DB) | Not run |
|---|---|---|---|---|
| Unit | 1,245 | 0 | — | — |
| Integration (DB) | 0 | 0 | 18 (10 Phase 1 + 8 identity admin) | — |
| E2E, no-DB server, 3 devices | 36 (auth pages ×21, degraded ×15) | 0 | 33 (phase1 ×21, admin ×9, seeded-admin ×3) | — |
| TypeScript / ESLint / `next build` | ✓ / ✓ (0 problems) / ✓ | — | — | — |
| `npm audit --omit=dev` | 0 vulnerabilities | — | — | — |

**Still required for Phase 1 sign-off:** Neon `.env` → `env:check` → migrate dev/test → seed dev → run the 18 integration + 33 e2e pending tests on Neon; `pg_dump` drill; production host decision.

### 2026-11-08 — First Neon contact (read-only)
- Connected through the pooled endpoint in ~1 s; **PostgreSQL 18.6**; pgvector **0.8.6 available** (not yet installed); database empty.
- Read-only session only — no migrations, seed or writes, because the branch (production vs development) was not identified.
- The connection string was shared in chat → owner advised to reset the `neondb_owner` password after setup.

### 2026-11-08 — Phase 1 security & reliability review
Environment: Node 26.13.0 (portable, official). Database checks ran against a **throwaway local PostgreSQL 18.6** (`embedded-postgres`, scratch folder) because the Neon project is not yet connected. pgvector was not available locally; the local migration copy omitted only the `CREATE EXTENSION vector` line. **Local results do not substitute for the Neon run.**

Fixes made during the review: F1–F7 (docs/SECURITY.md). Also: login page tolerates DB outage; e2e locator bug (Next route announcer) fixed in tests.

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | 13 roles × 79 permissions | **Passed** (code + DB) | 1,027 matrix cells in unit tests; `docs/RBAC_MATRIX.md` generated and checked; DB integration: all 13 roles loaded through real sessions match catalog exactly; seed = 79 permissions, 13 roles, 256 grants (idempotent) |
| 2 | Server-side authorization on sensitive operations | **Passed for Phase 1 surface** | Every page/action uses `requireAuth`/`authorize`; forced-change bypass blocked (F1); static sweep clean. Admin CRUD endpoints don't exist yet → covered when built |
| 3 | Student/parent isolation | **Permission level passed; record level not applicable yet** | Parents only CHILDREN-scoped, students only SELF-scoped, neither holds any write permission (unit). Record policies arrive with student data (Phase 3) |
| 4 | Payroll/financial isolation | **Permission level passed; record level not applicable yet** | Only 4 roles hold `payroll.read`; others at most `salary.self.read` SELF; finance writes limited to finance roles; preparers can't approve (unit). Record policies in Phases 7–8 |
| 5 | Transaction integrity | **Passed (local DB)** | Rollback doesn't consume sequence numbers; audit rows roll back with their transaction; lockout + audit atomic |
| 6 | 50 parallel unique IDs | **Passed (local DB)** | 50 concurrent Prisma transactions → 1..50 unique; 50 independent connections with forced lock contention → 50 unique. Negative control: naive `MAX()+1` gave **49 duplicates** in the same harness. Admission-level test (50 admissions) needs Phase 3 |
| 7 | Encryption/decryption | **Passed** | AES-256-GCM round-trip, fresh IV, tamper detection, wrong-key rejection, key rotation (old readable via `_V1`, new uses v2, removing old key makes old unreadable), HMAC lookup, masking, audit redaction |
| 8 | Backup & restore | **Logical drill passed (local); pg_dump drill not run; Neon PITR not run** | `scripts/backup-drill.ts`: 15/15 tables identical, restored DB writable. Running downloaded `pg_dump.exe` was blocked by tool policy |
| 9 | Desktop & mobile browsers | **Passed (local DB)** | Playwright on production build: 37 passed, 2 skipped (by design: seeded-admin test runs on desktop only), 0 failed — Desktop Chrome, Pixel 7, iPhone 14 (WebKit); axe: no serious/critical violations on scanned pages; no horizontal scroll; 44 px touch targets |
| 10 | Error handling / degraded DB | **Passed** | 15 degraded e2e tests: health 503 `{status:"degraded"}`, public + login pages render, login gives generic error, ERP shows friendly error with reference id, no internals leaked, no hangs |

**Test totals**
| Suite | Passed | Failed | Skipped | Not run |
|---|---|---|---|---|
| Unit (no DB) | 1,213 | 0 | 10 (integration, no DB configured) | — |
| Unit + integration (local PostgreSQL) | 1,223 | 0 | 0 | — |
| E2E (local PostgreSQL, 3 device profiles) | 37 | 0 | 2 (by design) | — |
| Integration on **Neon** | — | — | — | **all 10 — not run** |
| pgvector check | — | — | — | **not run** (Neon only) |
| `pg_dump`/`pg_restore` drill | — | — | — | **not run** |
| TypeScript / ESLint / `next build` | ✓ / ✓ / ✓ | — | — | — |

**Phase 1 is NOT complete.** Outstanding: Neon connection + real-database run; Users UI, Roles & Permissions editor, password reset (email `log` mode), shadcn/ui component library; pg_dump drill.

### 2026-11-08 — Phase 1 (part 2): Node 26, Git, settings
| Task | Result |
|---|---|
| Node 26 compatibility | Verified with official portable Node **26.13.0** / npm 11.20.0 (SHA-256 checked). `engines` → `>=26.0.0`, `.nvmrc` = 26, `@types/node` 26.6.6. Clean reinstall. No code changes needed. |
| npm 11 install scripts | Blocked by default; approved only `prisma@7.10.1`, `@prisma/engines@7.10.1`, `esbuild@0.28.2` (`allowScripts` in package.json). |
| Git | `git init -b main`. `.gitignore` hardened (`.env.*` with `!.env.example`, keys/certs, dumps, local storage, generated Prisma client). Verified with `git check-ignore`; dry-run add = 97 files, secret-pattern scan clean. **Nothing staged or committed.** |
| Claude settings | Env deny rules narrowed to real secret files (Read + Edit); JSON validated; `.env.example` confirmed readable. |
| `.env.example` | Was stale (earlier rewrite silently blocked) — rewritten with current variable names. |

**Test results under Node 26.13.0**
| Check | Passed | Failed | Skipped | Not run |
|---|---|---|---|---|
| TypeScript (`tsc --noEmit`) | ✓ | — | — | — |
| ESLint | ✓ (0 problems) | — | — | — |
| Unit tests | 168 | 0 | — | — |
| Integration tests (DB) | 0 | 0 | 6 (no `TEST_DATABASE_URL`) | — |
| `next build` | ✓ | — | — | — |
| Standalone server smoke test | ✓ `/api/health` → 503 `degraded` without DB, security headers present | — | — | — |
| `npm audit --omit=dev` | 0 vulnerabilities | — | — | — |
| E2E (Playwright) | — | — | — | not yet written |

**Database integration: NOT complete** — waiting for the owner's `.env`.

### 2026-11-08 — Phase 1 (part 1)
**Done and verified offline**
- Free-only infrastructure decisions; provider terms checked (FREE_TIER.md). Vercel Hobby and Gemini free tier ruled out for production/chatbot use.
- Next.js 16.4.5 + React 19.3 + TypeScript 6 + Tailwind 4 scaffold; `output: "standalone"`; security headers.
- Prisma 7.10.1 with `prisma.config.ts` (DIRECT_URL for CLI) and `@prisma/adapter-pg` (pooled DATABASE_URL at runtime, lazy client).
- Phase 1 schema (15 tables) + initial migration SQL generated offline with `prisma migrate diff`, including `CREATE EXTENSION vector`. Schema validates; client generates.
- Libraries: env validation, errors, AES-256-GCM field/file encryption + HMAC lookup, row-locked sequences + ID formatting, audit with redaction, RBAC catalog (79 permissions, 13 roles) + `authorize`/scopes, Argon2id passwords, DB sessions (hashed tokens, sliding renewal, revocation), login with lockout, Postgres rate limiter, free-tier usage guard.
- Seed (idempotent; preserves admin-edited grants), `npm run db:check` verification script.
- UI: login, forced password change, ERP shell (desktop sidebar + mobile bottom nav), dashboard with free-tier usage panel, logout, `/api/health`.
- Results: `tsc` clean · ESLint clean · **168 unit tests passed** · `next build` succeeded.

**Not yet verified (needs the Neon database)**
- `prisma migrate deploy`, `db:check`, seed, 6 integration tests (sequence concurrency, rollback, session/revocation, lockout, rate limit, usage cap) — currently **skipped**, not passed.
- Manual login flow in the browser.

**Remaining Phase 1 scope:** Users UI (create/deactivate/assign roles), Roles & Permissions editor, password reset via email (`log` provider), shadcn/ui setup, Playwright e2e (desktop + mobile), RBAC integration matrix on real endpoints.

### 2026-11-08 — Phase 0
- Repository was empty (no existing code to preserve).
- Environment: Node 21.1 (recommend 22 LTS), npm 10.8, git 2.52; PostgreSQL and Docker not installed.
- Created: CLAUDE.md, docs/* (16 files), README.md, .claude/ (settings, rules, skills, agents).
- Decisions recorded as ADR-001…015 in SYSTEM_ARCHITECTURE.md.
