# Security

Threat model summary: public internet exposure; data about minors (high sensitivity, India DPDP Act 2023 applies — verifiable parental consent, purpose limitation, breach notification); insider misuse (staff seeing salaries or medical info they shouldn't); payment fraud.

## Controls

| Area | Control |
|---|---|
| Authentication | See AUTHENTICATION_AND_RBAC.md (Argon2id, hashed session tokens, lockout, rate limits). |
| Authorization | Server-side `authorize()` + record policies in every service; integration tests assert 403 for each forbidden role on sensitive endpoints. |
| Input validation | Zod on every boundary (actions, routes, imports, webhooks). Reject unknown keys (`.strict()`) on mutation schemas. |
| SQL injection | Prisma parameterised queries only. `$queryRaw` allowed only with tagged-template parameters; `$queryRawUnsafe` banned by lint. |
| XSS | React escaping by default. CMS rich text sanitized server-side on save (DOMPurify/`sanitize-html` allowlist) and again on render. No `dangerouslySetInnerHTML` except the sanitized CMS renderer. |
| CSP & headers | `Content-Security-Policy` (nonce-based scripts), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, HSTS in prod, `frame-ancestors 'none'` (except map embed source allowlisted in `frame-src`). |
| CSRF | SameSite=Lax cookie + Origin check on all cookie-authenticated mutations. |
| Rate limiting | Login, reset, enquiry, chatbot, upload, export endpoints. |
| File uploads | Size caps per type; MIME detection from magic bytes (not extension); allowlist (jpg/png/webp/pdf/docx/xlsx/csv); images re-encoded with `sharp` (strips EXIF/GPS); random storage keys; private bucket; served via authorized handler with `Content-Disposition: attachment` for non-images. |
| Sensitive fields | Aadhaar, PAN, bank account: AES-256-GCM (key `DATA_ENCRYPTION_KEY`, versioned for rotation) + HMAC for lookup; masked in UI; full value only with `*.sensitive.read`, and each reveal is audited. |
| QR codes | Encode `https://<site>/verify/<verificationCode>` where the code is a random 128-bit token. The verify page shows only: valid/invalid, name initials, class, session, school. No DOB, phone, address, or IDs that allow enumeration. |
| Exports | Permission per module + per sensitive column; every export audited (who, what filter, row count). Formula injection prevented in CSV/XLSX (prefix `'` to cells starting with `= + - @`). |
| Payments | Amount/order created server-side; client callback never trusted; gateway signature verified; webhook HMAC verified with raw body; `PaymentGatewayEvent` dedupes; FeePayment idempotency key. |
| Payroll | Draft → prepared → approved (different user than preparer, enforced) → paid → locked. Salary changes require `salary.structure.manage` + approval record. |
| Chatbot | No ERP imports (lint), knowledge filtered to `isActive && PUBLISHED`, prompt-injection-resistant system prompt, output length caps, refusal on personal-data questions, rate limits, logged without IP (hashed). |
| Errors | Generic messages to clients with a request id; details only in server logs. |
| Secrets | Env vars only; `.env*` git-ignored and Claude-read-denied; `.env.example` holds names only. |
| Audit | Append-only AuditLog; DB role in prod lacks UPDATE/DELETE on `audit_log`. |
| Dependencies | `npm audit` in CI, Dependabot/Renovate, lockfile committed. |
| Backups | See BACKUP_AND_RECOVERY.md. |

## Phase 1 security review (2026-11-08)

| ID | Severity | Finding | Fix | Verified by |
|---|---|---|---|---|
| F1 | High | Forced password change enforced only in the ERP layout; Next.js layouts don't re-run on client navigation and server actions bypass layouts. | `requireAuth()` redirects by default; `authorize()`/`hasPermission()` deny every permission while a change is pending; only the change-password page/action opt out. | Unit test; e2e bypass attempts (direct URL + nav link) on 3 devices |
| F2 | Medium | Env validation existed but was never called. | `src/instrumentation.ts` validates at server start (names only in errors). | Unit tests |
| F3 | Medium | DB outage crashed homepage/login; no error boundaries; stale cookie made the login page fail. | Fallback school name; `error.tsx`/`global-error.tsx` with reference id only; login page tolerates failed session lookup. | e2e degraded suite (15 tests) |
| F4 | Medium | No DB connect timeout → requests could hang. | `connectionTimeoutMillis` (default 10 s, `DB_CONNECT_TIMEOUT_MS`). | Degraded run: responses < 0.1 s |
| F5 | Medium | Per-IP rate limit used the leftmost (client-controlled) `X-Forwarded-For` entry. | Use the entry appended by our proxy (`TRUSTED_PROXY_HOPS`, default 1). | Unit tests |
| F6 | Medium | `Secure` cookie tied to NODE_ENV: over plain HTTP, Safari/WebKit silently drops it (login appears to fail). | `Secure` follows `APP_URL` scheme; production boot **refuses** a non-HTTPS `APP_URL` (except localhost). | Unit tests; WebKit e2e |
| F7 | Low | Current-password check on password change not rate limited. | Shares the per-user login limit. | Code review |

Static sweep: no unsafe raw SQL, no `dangerouslySetInnerHTML`, no `eval`, no hard-coded credentials, no secret values in logs; interpolated SQL only uses constant table names (scripts).

## Phase 1 administration controls (2026-11-08)

- User/role administration follows the rules in AUTHENTICATION_AND_RBAC.md §2a (Super Admin protection, last-Super-Admin guard, anti-escalation), implemented as pure, unit-tested policy functions re-checked inside each transaction.
- Temporary passwords: ~70-bit random, shown once in the UI, stored only as Argon2id hashes, force a change at first sign-in.
- Password reset: no account enumeration (identical response and timing path), rate limited, single-use 30-minute tokens stored hashed, `no-referrer` on the reset page, all sessions ended on completion. Reset links appear in logs only in development (`EMAIL_PROVIDER=log`); production logs show recipient (masked) and subject only. Note: hosting access logs may record the full reset URL — keep host log retention short.
- Cron endpoint: bearer secret compared in constant time; disabled when `CRON_SECRET` is unset or shorter than 32 characters; returns counts only.
- Accessibility/security of errors: server actions map only `AppError` messages to users; anything else becomes a generic message (logged by error name only).

## Offline security & architecture audit (2026-11-08)

Scope: password reset, RBAC/escalation, Super Admin concurrency, sessions & cleanup, crypto/audit/sensitive data, validation/transactions/errors, mobile/a11y, module boundaries. No database was contacted; DB-dependent behaviour is covered by pending integration tests.

| ID | Sev. | Finding | Fix | Verified by |
|---|---|---|---|---|
| A1 | **High** | Delegated admins (non–Super Admin with `user.manage`) could reset the password of a **more-privileged** user (e.g. Principal) and sign in as them — account-takeover escalation. | Non–Super Admins may only modify users whose entire permission set they hold (`assertCanModifyUser`, fail-closed if target permissions aren't loaded). | Unit; integration (pending) |
| A2 | **High** | Last-Super-Admin guard used `SELECT … FOR UPDATE` over a join. Under READ COMMITTED, joined rows come from the old snapshot, so "remove A's Super Admin role" racing "deactivate B" could leave **zero** Super Admins. | Transaction-scoped advisory lock (`pg_advisory_xact_lock`) taken first in every transaction that can change Super Admin membership; works through Neon's transaction pooler. | Integration race test (pending) |
| A3 | **High** | The ESLint ban on `$queryRawUnsafe`/`$executeRawUnsafe` **never worked**: in a JS string `"\$"` became `"$"`, producing a regex that can't match. | Selector written with `String.raw`; probe file confirmed the rule now fires. | Lint probe |
| A4 | Medium | Session sliding renewal computed lifetime as `expiresAt − createdAt`, which grew on every renewal → sessions could live indefinitely; the documented 30-day absolute cap wasn't enforced. | Pure `nextSessionExpiry()`: idle lifetime = `expiresAt − lastSeenAt` (invariant), capped at `createdAt + 30 days`. | Unit (10 consecutive renewals stay at 8 h; cap respected) |
| A5 | Medium | Password-reset token in the URL **query string** → recorded by reverse proxies/host access logs/analytics. | Token moved to the URL **fragment** (never sent to servers); page strips it from history immediately and POSTs it. | Unit (no query string); e2e (fragment stripped, token absent from every requested URL) |
| A6 | Medium | Reset-request response time revealed whether an account exists (writes + email only for real accounts). | Rate limits stay synchronous; lookup/token/email run in `after()` once the response is sent. | Code review; e2e neutral response |
| A7 | Medium | No Content-Security-Policy despite this document promising one. | Per-request nonce CSP in `src/proxy.ts` (`strict-dynamic`, no `unsafe-inline` scripts, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`). All pages render dynamically (required for nonces; also prevents shared caching of sensitive pages). | Unit; e2e: header present, 0 CSP violations, hydration works |
| A8 | Medium (cost) | `/api/health` queried the DB on every request → an uptime monitor would keep Neon compute awake 24/7 (~180 CU-h/month vs 100 free). Public pages also queried the school name on every request. | Liveness-only by default; DB check via `?deep=1` with `CRON_SECRET`. School name cached 5 min per instance (last good value survives outages). | e2e; unit (mocked DB) |
| A9 | Medium | Dashboard read usage data from `lib/` without `authorize()` in that path. | `modules/system/usage.service.ts` enforces `usage.read`. | Code review |
| A10 | Low | Rate-limit bucket keys stored raw usernames/emails. | Keys use an HMAC of the subject. | Unit |
| A11 | Low | Dev email "log" mode printed reset links to the console. | Console shows kind, masked recipient, subject and the outbox file path only; body only in the git-ignored outbox file (never in production). | Unit |
| A12 | Low | Audit redaction missed `token`, `temporaryPassword`, `newPassword`, `currentPassword`, `confirmPassword`, `secret`. | Added. | Unit |
| A13 | Low | Scope ordering treated ASSIGNED as covering CHILDREN. | Partial order: ALL ⊇ all; X ⊇ X; any ⊇ SELF. | Unit |
| A14 | Low | Session cookie lacked the `__Host-` prefix. | `__Host-sid` over HTTPS (Secure, Path=/, no Domain enforced by browsers). | Unit |
| A15 | Low | Argon2 hash computed inside the reset transaction while holding a row lock. | Pre-check + hash outside; token re-verified under lock. | Code review; integration (pending) |
| A16 | Low | `checkResetTokenAction` (public) had no rate limit — could be used to keep the DB awake. | 30/hour per client. | Code review |
| A17 | Low | Concurrent `createRole` with the same key surfaced a generic error. | Unique violation mapped to a field error. | Code review |
| A18 | Low | Malformed `/erp/users` query params → error page. | `safeParse` with defaults. | Code review |
| A19 | Low | Components imported nav config from `app/` (boundary violation); no automated boundary checks. | Config moved; ESLint layer rules + `npm run check:deps` (cycles + layers, verified against planted violations). | Tool |
| A20 | Low (a11y) | No skip link; filter chips used `aria-current="page"`. | Skip-to-content link + focusable `<main>`; `aria-current="true"`. | Code review |

Reviewed and found sound: Argon2id parameters; 256-bit session and reset tokens stored as SHA-256; session revocation on deactivate/password change/reset; lockout with generic errors and timing equalization; server actions' built-in Origin check (CSRF); bearer secret compared in constant time; AES-256-GCM with versioned keys and tamper detection; audit writes inside the same transaction; Zod `.strict()` on every action; `AppError`-only user messages; no circular dependencies.

## Data retention (to be confirmed with school — see KNOWN_ISSUES)

Student academic & admission records: permanent (school register). Fee/payroll financial records: ≥ 8 years. Chat logs: 90 days. Sessions: deleted on expiry. Import staging rows: 30 days.

## Reporting

Security issues: report privately to the school's designated system administrator (contact configured in settings). Do not open public issues.
