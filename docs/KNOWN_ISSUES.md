# Known Issues & Open Items

| ID | Type | Description | Status |
|---|---|---|---|
| KI-001 | Environment | Neon project not yet created; DB-dependent checks and 6 integration tests are skipped until `.env` is filled (DEPLOYMENT.md → Neon setup). | Open |
| KI-002 | Environment | System Node.js was removed when an interrupted upgrade (to 26) rolled back on 2026-11-08; Node 22.23.4 reinstalled system-wide the same day. | Resolved 2026-11-08 |
| KI-006 | Dependencies | `npm audit`: 8 moderate advisories in `@typescript-eslint/*` (dev-only lint tooling, via eslint-config-next). Not shipped to production. Re-check on next eslint-config-next release. | Open |
| KI-007 | Policy | Vercel Hobby terms forbid non-personal use; a production host permitting institutional use must be chosen (PROJECT_PLAN Q15). | Open |
| KI-008 | Tooling | `.claude/settings.json` deny rule `Read(./.env.*)` blocked `.env.example`. Fixed 2026-11-08: explicit Read/Edit denies for `.env`, `.env.local`, `.env.*.local`, `.env.development`, `.env.production`, `.env.test`. Side effect found: the earlier `.env.example` rewrite had silently not happened; rewritten and verified. | Resolved |
| KI-003 | Requirements | Open owner questions Q1–Q15 in PROJECT_PLAN.md. | Open |
| KI-004 | Legal | DPDP Act 2023 consent and retention policy not yet confirmed with the school. | Open |
| KI-005 | Repo | Git initialized 2026-11-08 (branch `main`); **no commits yet** — awaiting owner approval. Until the first commit there is no version history. | Partly resolved |
| KI-009 | Environment | System Node is still 22.23.4; owner is installing Node 26 LTS. Node 26 compatibility was verified with the official portable 26.13.0 build; re-run the gate after the system install. | Open |
| KI-011 | Verification | All DB/e2e results so far are from a local PostgreSQL 18.6; Neon runs PostgreSQL 17 with a pooler. Integration + e2e + `db:check` must be re-run on Neon before Phase 1 sign-off. pgvector unverified. | Open |
| KI-012 | Backup | `pg_dump`/`pg_restore` drill not run: executing the downloaded PostgreSQL client binaries was blocked by tool policy. Owner to run or approve. | Open |
| KI-013 | Housekeeping | Cleanup implemented (`/api/cron/cleanup`, `npm run cleanup`, GitHub Actions workflow). Not yet exercised against a real database; the scheduler needs `APP_URL` + `CRON_SECRET` secrets after deployment. | Partly resolved |
| KI-014 | Scope | Users UI, Roles & Permissions editor, password reset, shadcn/ui migration implemented 2026-11-08. Their DB-backed flows are **untested against a database** (integration + e2e specs written, pending). | Partly resolved |
| KI-016 | Testing | 8 identity integration tests and 33 e2e tests (phase1, admin, seeded-admin specs × 3 devices) are written but **pending** a database. | Open |
| KI-017 | Security | Password-reset requests are rate limited per identifier (5/hour), so a third party could temporarily block reset emails for a known username. Admin reset remains available. | Accepted |
| KI-018 | Security | Reset tokens were in the URL query string (host logs). Moved to the URL fragment, which is never sent to servers (A5). Remaining exposure: the user's own browser history until the page strips it (immediately on load) and the email itself. | Resolved |
| KI-021 | Verification | Audit fixes A1, A2, A15 change DB-backed code paths; their integration tests (incl. the Super Admin race and account-takeover tests) are pending a database. | Open |
| KI-022 | Design | Strict delegation (A1): a delegate can only manage accounts whose permissions they fully hold, so a School Admin delegate cannot manage Teacher accounts unless also granted the Teacher permissions. Intentional; revisit if it hampers daily administration. | Accepted |
| KI-023 | Performance | All pages render dynamically (nonce CSP, ADR-024). Public pages in Phase 2 must cache their data (not pages) to stay fast and Neon-friendly. | Open (Phase 2) |
| KI-024 | Security | Production DB role should lack UPDATE/DELETE on `audit_log` (append-only at the DB level) — needs a separate least-privilege Neon role; not yet created. | Open |
| KI-025 | Operations | `after()` (deferred reset processing) needs post-response execution support on serverless hosts; fine on the standalone Node server. | Open (host choice) |
| KI-026 | Accessibility | ERP screens (users, roles, account, dashboard) can't be scanned offline (they need a session → DB); axe coverage for them is in the pending admin/phase1 e2e specs. | Open |
| KI-019 | UX | Account page and dashboard show role names from the built-in catalog; custom roles display their key. | Open |
| KI-020 | Dependencies | The shadcn init placed the `shadcn` CLI in runtime `dependencies`, pulling 6 audit advisories (deepmerge, minimatch via ts-morph) into the production tree. Moved to `devDependencies` (only its CSS is used, inlined at build) → `npm audit --omit=dev`: 0 vulnerabilities. | Resolved |
| KI-015 | Testing | Per-IP rate limit (20 / 15 min) is shared by all users behind one school NAT/Wi-Fi; per-account limits still apply. Revisit thresholds with real usage. | Open |
| KI-027 | CI | Not yet run on GitHub's Ubuntu runner; validated by a clean-checkout simulation on Windows only. First real run happens on the first push. | Open |
| KI-028 | Tooling | `prisma.config.ts` uses `env("DIRECT_URL")`, so `npm ci`/`npm install` fail without that variable even though `prisma generate` never connects. CI sets a non-secret placeholder. A follow-up could make the config tolerate a missing URL for `generate` (not changed now: working scripts left as-is). | Open |
| KI-029 | Repo | GitHub `main` had an initial commit (`eb0fb1d`: MIT LICENSE + GitHub's **Python** .gitignore) while the local repo had none. Reconciled 2026-11-08 without force: local work committed on top of `eb0fb1d`, LICENSE kept, Python .gitignore replaced by the project's Node/Next.js rules (its `lib/` pattern would have excluded `src/lib/`). | Resolved |
| KI-030 | CI | Integration and e2e suites are not in CI (need a database/server). Option later: a disposable Postgres service container in CI with synthetic data only (no Neon). | Open |
| KI-010 | Scope | "50 simultaneous admissions" and "duplicate prevention" tests need the admission module (Phase 3). Phase 1 covers the underlying mechanism (50 concurrent sequence allocations, unique constraints); the admission-level tests are written in Phase 3. | Open |
