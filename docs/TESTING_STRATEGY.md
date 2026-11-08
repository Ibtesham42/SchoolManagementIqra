# Testing Strategy

## Layers

| Layer | Tool | Scope | DB |
|---|---|---|---|
| Unit | Vitest | Pure logic: roll-number ordering, ID formatting, fee/late-fee/concession calc, payroll calc, grade calc, import parsers & validators, sanitizers, permission resolution | none |
| Integration | Vitest | Services through Prisma: transactions, sequences under concurrency, RBAC/policy enforcement, audit writes, webhooks | real Postgres (dedicated test DB, reset per file via transaction rollback or truncate) |
| E2E | Playwright | Critical user journeys in a browser, projects: Desktop Chrome, Pixel 7, iPhone 14 | seeded test DB |
| Accessibility | `@axe-core/playwright` | Every e2e page visited is scanned; no serious/critical violations | — |
| PDF | Vitest | Generated PDFs: text extraction asserts required fields present and sensitive fields absent | — |

Mocks are allowed only for external providers (payment gateway, LLM, email). **Never mock Prisma** in integration tests.

## Mandatory test cases (traceable to spec)

- Auth: login success/failure, lockout, session expiry, revocation on deactivate, password reset single-use.
- RBAC: for each sensitive endpoint, a table-driven test over all 13 roles asserting allow/deny; IDOR tests (teacher accessing non-assigned section, parent accessing another child).
- Admission: required fields, duplicate detection, 50 concurrent creations → unique, gap-free (per transaction success) IDs.
- IDs immutable on edit.
- Roll numbers: alphabetical case-insensitive (`amit`, `Ananya`, `ÁNIL`), per-section, tie-breaks, preview has no side effects, finalize locks, correction audited, student IDs untouched.
- ID cards: PDF contains required fields; QR resolves to verify page without PII.
- Payroll: LOP, half-days, advance recovery, bonus/arrears, maker ≠ checker, slips snapshot unaffected by later structure change.
- Fees: concessions, late fees, installments, partial payments, allocation, duplicate transaction ref rejection, webhook signature invalid → rejected, replayed webhook → no double credit.
- Attendance: one record per student per day, percentage calc with holidays.
- Transport: route capacity, fee linkage.
- Import: mapping, validation errors reported per row, duplicates skipped, re-running the same file is idempotent.
- Export: sensitive columns excluded without permission; CSV formula injection neutralised.
- Chatbot: answers from active published knowledge only; inactive/draft never retrieved; unknown → contact-office fallback; refuses personal-data questions.
- CMS: draft not visible publicly; publish revalidates; sanitized HTML.
- Mobile: e2e journeys (login, mark attendance, collect fee, admission step 1–5) pass on Pixel 7 & iPhone 14 projects.

## Running the suites

| Suite | Command | Needs |
|---|---|---|
| Unit | `npm test` (integration auto-skips without a test DB) | nothing |
| Integration | `npm test` with `TEST_DATABASE_URL` set (Neon `test` branch, migrated with `DIRECT_URL=<test direct> npm run db:deploy`) | test DB |
| E2E | `npm run build`, copy `.next/static` into `.next/standalone/.next/`, start `node .next/standalone/server.js`, then `E2E_BASE_URL=… E2E_DATABASE_URL=<dev DB> npm run test:e2e` | dev DB seeded |
| E2E degraded | also start a second instance with an unreachable `DATABASE_URL` and set `E2E_DEGRADED_BASE_URL` | — |
| Architecture | `npm run check:deps` (cycles + layer boundaries) and `npm run lint` (layer rules, unsafe-SQL ban) | — |
| E2E deep health | set `E2E_CRON_SECRET` to the test server's `CRON_SECRET` to exercise `/api/health?deep=1` | — |
| RBAC matrix doc | `npm run rbac:matrix` after changing `src/lib/rbac/catalog.ts` (a unit test fails if the doc is stale) | — |

| E2E offline (no DB) | start the server with an unreachable `DATABASE_URL`; set `E2E_BASE_URL` and `E2E_DEGRADED_BASE_URL` to it and leave `E2E_DATABASE_URL` unset → auth-pages + degraded specs run, DB specs skip as **pending** | — |

Skipped tests are reported as skipped, never as passed. A run against a local PostgreSQL is useful for development but does not replace the Neon run.

## Gates

`npm run lint && npm run typecheck && npm test` must pass before any commit claiming a feature; `npm run test:e2e` before closing a phase. Coverage target: ≥ 90% lines on `src/modules/**/**.service.ts` and pure calc libs.
