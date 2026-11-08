# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow SemVer once the first release ships.

## [Unreleased]

### Security (offline audit, 2026-11-08 — see SECURITY.md A1–A20)
- Delegated admins can no longer modify (reset, deactivate, edit, sign out) users more privileged than themselves.
- Super Admin membership changes serialized with a transaction-scoped advisory lock (fixes a race that could leave zero Super Admins).
- Unsafe raw-SQL lint rule fixed (it never matched); layer-boundary lint rules and `npm run check:deps` added.
- Sessions: renewal no longer extends lifetime indefinitely; 30-day absolute cap enforced; `__Host-` cookie prefix on HTTPS.
- Password reset: token moved to the URL fragment (kept out of server logs), processing deferred so timing doesn't reveal accounts, token checks rate limited, dev console no longer prints email bodies.
- Nonce-based Content-Security-Policy on all pages; all pages render dynamically.
- `/api/health` is liveness-only (deep DB check needs `CRON_SECRET`); public school name cached — prevents uptime monitors and crawlers from draining Neon's free compute hours.
- Rate-limit keys hashed (no usernames/emails stored); more audit redaction keys; scope coverage is a partial order.

### Added (Phase 1 completion work, offline)
- User management (create with one-time temporary password, edit, roles, deactivate/reactivate, admin reset, unlock, sign out everywhere).
- Roles & permissions management (create, rename, per-permission scope editor, delete unused roles).
- Super Admin protections, last-Super-Admin guard and anti-escalation policy (`identity.policy.ts`).
- Self-service password reset (forgot/reset pages, single-use hashed tokens, email `log`/Resend providers with free-tier cap).
- My account page (change password, sign out other devices); "not permitted" screen; confirmation dialogs.
- Scheduled cleanup endpoint, CLI script and GitHub Actions workflow; `npm run env:check` (branch-identity guard).
- shadcn/ui component library (radix-nova) with 44 px mobile controls; e2e auth-pages and admin specs; unit tests for policies, schemas, email, cron auth.

### Fixed
- Forgot-password page was prerendered at build time (school name frozen) — now dynamic.
- Error text colour failed WCAG AA (4.49:1) — destructive colour now red-700 (6.5:1).
- `shadcn` CLI moved to devDependencies (removed 6 advisories from the production dependency tree).

### Security
- Forced password change now enforced in `requireAuth()` and `authorize()` (was layout-only and bypassable).
- Rate-limit client IP taken from the proxy-appended `X-Forwarded-For` entry (`TRUSTED_PROXY_HOPS`).
- Session cookie `Secure` follows the `APP_URL` scheme; production refuses non-HTTPS `APP_URL`.
- Environment validated at server start; DB connection timeout; change-password verification rate limited.

### Added
- Error boundaries; graceful degradation of public/login pages when the DB is unreachable.
- `docs/RBAC_MATRIX.md` (generated, test-enforced) and full 13×79 matrix tests; data-isolation invariant tests.
- Integration tests: DB-loaded permissions for all roles, deactivation, audit rollback, true 50-connection concurrency.
- Playwright e2e (Desktop Chrome, Pixel 7, iPhone 14) incl. axe accessibility and degraded-DB suites.
- `scripts/backup-drill.ts` logical backup/restore verification; `npm run rbac:matrix`, `npm run test:e2e`.

### Changed
- Runtime moved to Node.js 26 LTS (`engines >=26.0.0`, `.nvmrc`, `@types/node` 26); npm 11 install-script allowlist added.
- `.gitignore` hardened; Git repository initialized (no commits).
- Claude settings: env-file deny rules limited to real secret files; `.env.example` corrected to current variables.

### Added
- Free-tier infrastructure strategy (docs/FREE_TIER.md, ADR-016…021).
- Next.js 16 / Prisma 7 project scaffold; Phase 1 schema and initial migration (with pgvector).
- Authentication (Argon2id, DB sessions, lockout, rate limiting), RBAC engine with 13 seeded roles, audit log, encryption, sequences, free-tier usage guard.
- Login, forced password change, ERP shell, health endpoint; seed and `db:check` scripts; unit and integration tests.
- Phase 0 architecture, database design, security model and project documentation.
- Claude Code project configuration: rules, skills, agents.
