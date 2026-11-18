# Security audit — Phase 2B closure review (2026-11-10)

**Status (updated 2026-11-10, after owner approval):** fixes implemented for S-01, S-02, S-03, S-04, S-05, S-06, S-08, S-09, S-10, S-11, S-12, S-13, S-14 and the three export hardening items — offline-verified (unit/route tests, static guards, build); their database behaviour is covered by `tests/integration/security-fixes-2b.test.ts`, **written, not yet run**. S-07, S-15 and S-20 are design/proposal only (Appendices A–C). See §0.
**Method:** three independent read-only `security-auditor` reviews (1: authentication, sessions, RBAC, IDOR, Class Teacher isolation, field-level edits; 2: admissions concurrency, private files, CSV export; 3: audit, validation, headers, logs, environment separation), then each Medium finding re-checked against the code by the lead reviewer. Actual implementation reviewed, UI/route → action → service → query. No file changed, no `.env*` read, no database accessed. Offline unit suites run by the reviewers: 31 file runs / 896 test runs, all passing (some files were run by more than one reviewer; the full unit suite — 44 files / 2,196 tests — passed earlier the same day).

**Severity:** Critical (exploitable now, major impact) · High · Medium · Low · Info. **Status:** CONFIRMED = a concrete path exists in the code; THEORETICAL = needs a misconfiguration, a custom role, or access the app doesn't give. **Origin:** whether Phase 2B introduced it or it predates Phase 2B.

## 0. Fix status (2026-11-10; owner decisions on S-07, S-15, S-20 recorded 2026-11-18)

**2026-11-18 owner decisions:** **S-07** — migration `20261118000000_audit_log_append_only` created for review (Appendix B, one transaction + lock timeout; `db:check` verifies the triggers once applied) — **not applied**. **S-15** — approved: 30-day grace period, `stored_file.purged_at` (migration `20261118000100_stored_file_purged_at`, created for review — **not applied**), purge job `src/modules/files/files-purge.ts` + guarded runner `npm run files:purge` (dry run by default; first run as a dry run); orphan-blob reconciliation pending (KI-067); live-document retention period still to be decided with the school (KI-004). **S-20** — Appendix C diff applied to `.claude/settings.json`.


| ID | Decision | Implemented | Verification |
|---|---|---|---|
| S-01 | Fix | Upload route refuses users without `student.document.manage` + ALL-scope `admission.read` (incl. a pending password change) **before** taking an upload slot or reading the body; `readBodyWithLimit` has a 120 s overall deadline (stream cancelled) → `RequestTimeoutError` 408 / fixed code `too_slow` | `document-routes.test.ts` (Teacher, Accountant, pending-change officer → 403, body reader never called); `security-fixes-2b.test.ts` (stalled stream rejected + cancelled; code/status) |
| S-02 | Fix | ASSIGNED student scope and the academic scope helpers count a class-teacher assignment only while its session is not CLOSED; class-teacher **removal** allowed on closed sessions (assigning still refused); the sections page offers "Remove class teacher" on closed sessions | unit scope expectations updated (`student-records`, `academic-rules`); integration S-02 (pending) |
| S-03 | Fix | Login: per IP (all attempts) + per **(username, IP)** (all attempts, 10/15 min) + per-username **failures-only** ceiling (30/15 min, checked before work); account lock after 5 failures unchanged; every failure path records a failure; admin unlock, admin password reset and a completed reset clear the user's limiter buckets; password change has its own bucket | `security-fixes-2b.test.ts` (memory driver: other IP not blocked, peek, reset; source pinned); integration S-03 (pending) |
| S-04 | Fix | Files route: in-process per-IP limit (120/min, never the database) before any lookup; anonymous "not found" answers cached 5 min (bounded, anonymous only); no session lookup without a session cookie | `files-route.test.ts` (miss cached, signed-in not affected, 429 before the service); `security-fixes-2b.test.ts` (`hitLocal`, `TtlSet`) |
| S-05 | Fix | Vitest `globalSetup` (integration scope only): refuses shell database variables; requires `TEST_TARGET_BRANCH_ID` / `TEST_TARGET_ENDPOINT_ID` (**the owner must add them to `.env`**), FORBIDDEN_* and SEED_TARGET_* present; URL host = allow-list, never development or production; live read-only identity check before any suite runs | `security-fixes-2b.test.ts` (resolve/identity cases, wiring, shell refusal) |
| S-06 | Fix | e2e setup: the same allow-list guard (`E2E_TARGET_*`) + live identity before writing; accounts created in one transaction with the Super Admin advisory lock first and an audit row each; new `global-teardown.ts` removes them (guarded, audited); the `/prod/i` heuristic removed | `security-fixes-2b.test.ts` (source pinned, e2e target cases) |
| S-07 | Design only | — | Appendix B |
| S-08 | Fix | `ALLOWED_SCOPES` per permission (ALL + the scopes the default roles use; `*.self.*` = SELF only); the role editor shows only those; `setRolePermissions` refuses new or changed unsupported scopes (unchanged older grants are left alone) | `security-fixes-2b.test.ts` (catalog consistency, ALL-only services, policy) |
| S-09 | Fix | Losing every class-teacher-eligible role releases the user's sections in the same transaction (row-locked, versioned, audited `section.class_teacher_unassign`) | `security-fixes-2b.test.ts` (source pinned); integration S-09 (pending) |
| S-10 | Fix | The files route serves non-public files through `privateFileResponse` (PDF: sandboxed attachment; images inline; `no-store`) | `files-route.test.ts` |
| S-11 | Fix | CSV: quote on `;` and tab too; formula prefix also after leading whitespace/control characters and for full-width `＝＋－＠` | `security-fixes-2b.test.ts` |
| S-12 | Fix | The roll-number sheet requires `student.read` ALL (checked before any database access); the preview returns no date of birth or internal id | `security-fixes-2b.test.ts` (refused without the database; Principal reaches the database) |
| S-13 | Owner decision → fix | A Class Teacher (ASSIGNED) can't change a guardian linked to any student outside their scope; School Admin (ALL) can; the form note explains. Guardian `version` column not added (migration) | integration S-13 (pending) |
| S-14 | Owner decision → fix | The creator of an application can't approve it (checked under the application lock; applies to every approver incl. Super Admin); another School Admin or the Principal can; the review page shows a notice instead of the form | `security-fixes-2b.test.ts`; integration S-14 (pending) |
| S-15 | Proposal only | — | Appendix A |
| S-20 | Diff only | — | Appendix C |
| Export ×3 | Fix | The audit stores only `search: { used, length }` (never the text); the body is read through the capped reader (10 s); one query fetches limit + 1 rows and refuses above the limit (no count/fetch race) | `security-fixes-2b.test.ts` |
| S-16 (part) | — | Not approved separately, but the S-03 change records a failure on **every** failure path (unknown, inactive, locked, wrong password), which also equalises one extra round trip; the lock-counter race remains | — |

## 1. Summary

**No Critical or High findings.** Core controls hold: every service authorizes before data access; id-based student reads and writes are filtered by record scope in the same query (missing and forbidden both 404); permanent IDs are not editable (strict schemas); approval is protected by row locks, version checks and unique constraints (tested with 50 concurrent approvals); private files are encrypted, magic-byte checked, owner-bound and served with `nosniff`/`no-store`; custom POST routes check Origin; CSP is nonce-based; errors never leak internals; no `$queryRawUnsafe`.

| ID | Sev | Status | Origin | Title |
|---|---|---|---|---|
| S-01 | **Medium** | CONFIRMED | Phase 2B (S4) | Upload concurrency slots are taken and the 10 MB body is read **before** the permission check, with no read deadline — any signed-in user can block document uploads |
| S-02 | **Medium** | CONFIRMED | Phase 2 / 2B | Class Teacher access to a section's students never ends after its session is CLOSED, and the teacher can't be unassigned on a closed session |
| S-03 | **Medium** | CONFIRMED | Phase 1 | Per-username login limit counts every attempt, so anyone can keep an account from signing in; admin unlock doesn't clear it |
| S-04 | **Medium** | CONFIRMED | Phase 2a | `GET /api/v1/files/:id` is unauthenticated, not rate limited and queries the database on every cache miss (project rule) |
| S-05 | **Medium** | THEORETICAL | Test infra | Integration tests write to whatever `TEST_DATABASE_URL` points at — no live target-identity guard |
| S-06 | **Medium** | THEORETICAL | Test infra (Phase 1) | e2e global setup inserts Super Admin accounts with raw SQL; only guard is `/prod/i` on the URL; no audit, no teardown |
| S-07 | **Medium** | CONFIRMED (known KI-024) | Phase 1 | `audit_log` append-only by convention only — no DB trigger/grant stops UPDATE/DELETE |
| S-08 | Low | CONFIRMED (custom role) | Phase 1 / 2B | Non-ALL scopes are ignored by most services, but the role editor offers them for every permission |
| S-09 | Low | CONFIRMED | Phase 2 / 2B | A stale `classTeacherId` after a role change gives another role with ASSIGNED `student.read` (Transport Manager) that section's students |
| S-10 | Low | CONFIRMED | Phase 2a | `/api/v1/files/:id` shows private PDFs inline without `Content-Security-Policy: sandbox` (dedicated routes do sandbox) |
| S-11 | Low | CONFIRMED | Phase 2B (S7) | CSV formula guard bypass for `;`-separated spreadsheets via class names (`;` and `=` allowed) |
| S-12 | Low | CONFIRMED | Phase 2B (S6) | Roll-number sheet returns names, IDs and dates of birth without a `student.read` check |
| S-13 | Low | CONFIRMED (design) | Phase 2B (S7) | Class Teacher can change a shared guardian's phone/email that also belongs to a sibling in another section; no version check on guardians |
| S-14 | Low | CONFIRMED (design D2) | Phase 2B (S5) | Maker-checker is by role only — School Admin / Super Admin can create and approve the same application |
| S-15 | Low | CONFIRMED | Phase 2B (S4) | Removed/replaced private document blobs and orphans are never deleted (no housekeeping job) |
| S-16 | Low | CONFIRMED | Phase 1 | Login timing reveals active usernames; failed-login counter has a read-then-write race |
| S-17 | Low | CONFIRMED (no exposure yet) | Phase 1 | Audit redaction matches exact key names only; `salary` missing |
| S-18 | Low | CONFIRMED | Phase 1 | `db:migrate` / `db:deploy` have no target guard; a shell `DIRECT_URL` overrides `.env` |
| S-19 | Low | THEORETICAL | Phase 1 | `scripts/db-check.ts`, `scripts/cleanup.ts` print raw driver error messages (no `sanitize`) |
| S-20 | Low | CONFIRMED | Claude config | `.claude/settings.json` denies only specific `.env` names and only Read/Edit (owner decision — not changed) |
| S-21 | Low | CONFIRMED | Phase 2a | `/api/v1/documents/preview` renders a PDF on every call, no rate limit |
| S-22 | Low | THEORETICAL | Phase 2a | File encryption has no AAD and the stored `sha256` isn't checked on read (blob swap needs storage write access) |
| S-23 | Info | — | various | Hardening items (§3) |

Phase 2B introduced S-01, S-11, S-12, S-13, S-14, S-15 and shares S-02, S-08, S-09; the rest predate Phase 2B.

## 2. Details (Medium and Low)

### S-01 — Medium — uploads: slots before authorization, no body deadline (CONFIRMED)
- **Evidence:** `src/app/api/v1/admissions/[id]/documents/route.ts:13` `const slots = new UploadSlots(2);` (shared per instance); `:31-41` order is origin → `getAuthContext()` (any session) → `enforce(RULES.upload)` → `assertUploadHeaders` → `slots.run(() => parseMultipart(await readBodyWithLimit(request.body, …)))` → only then `addApplicationDocument`, which first calls `authorize(ctx, "student.document.manage")` (`src/modules/admissions/documents.service.ts:40`). `src/lib/http/upload.ts:58-84` `readBodyWithLimit` loops on `reader.read()` with no deadline.
- **Exploit:** any signed-in user (Teacher, Librarian, a pending-password-change account) sends 2 POSTs claiming 10 MB and trickles bytes; both slots stay occupied until the server's request timeout; every Admission Officer upload gets "busy". Each low-privilege request also makes the server buffer up to 10 MB before refusal.
- **Fix:** before `slots.run`, a cheap gate — `hasPermission(ctx, "student.document.manage") && scopeFor(ctx, "admission.read") === "ALL"` else 403 (the service keeps its authoritative check); give `readBodyWithLimit` an overall deadline (e.g. 30 s, cancel the reader); optionally per-user slot accounting.
- **Verify:** route test — a Teacher request gets 403 and `readBodyWithLimit` is never called (spy); a never-ending stream is rejected after the deadline and frees its slot.
- **Tests today:** `upload-http.test.ts` / `document-routes.test.ts` cover the byte cap, lying Content-Length, slot release — not auth-before-body or a deadline.

### S-02 — Medium — Class Teacher access outlives a closed session (CONFIRMED)
- **Evidence:** `src/modules/students/students.policy.ts:23` ASSIGNED = `enrollments: { some: { status: "ACTIVE", section: { classTeacherId: userId } } }` — no session condition. Closing a session (`settings.service.ts` `changeAcademicSessionStatus`) leaves its enrollments ACTIVE; `changeStudentStatus` deliberately skips closed sessions (`students.service.ts` `=== "CLOSED") continue`), so a later transfer leaves the closed-session enrollment ACTIVE. `unassignClassTeacher` → `lockSectionForWrite` → `assertSessionWritable` (`sections.service.ts:93`, `:307-310`) refuses on a CLOSED session. Promotion (Phase 4) doesn't exist yet.
- **Exploit:** after 2026-27 closes, the former class teacher of 5-A keeps reading profiles (guardian contacts, address, status reasons), photos and contact-editing for every student who was in 5-A — including those who later left — until their role is removed.
- **Fix:** restrict ASSIGNED to non-closed sessions (`section: { classTeacherId, academicSession: { status: { not: "CLOSED" } } }`) in `studentScopeWhere` and the academic scope helpers (`academic.policy.ts` `sectionScopeWhere` / `classScopeWhere` / `canReadSection`); and allow class-teacher **unassignment** on closed sessions (an access change, not academic data).
- **Verify:** integration — admit into A, close the session, then `listStudents(classTeacher)` = 0 and `getStudent` / `updateStudent` → NotFound; unit case in the "record scope policy" block.
- **Tests today:** none for closed sessions.

### S-03 — Medium — login limit can lock out any account (CONFIRMED, Phase 1)
- **Evidence:** `src/modules/identity/auth.service.ts:31-32` `enforce(RULES.loginPerIp, …); enforce(RULES.loginPerUser, input.username);` run before the password check; every attempt counts (`src/lib/rate-limit.ts` `loginPerUser` 10 / 15 min). Admin unlock clears `lockedUntil`, not the bucket. `changeOwnPassword` shares the bucket.
- **Exploit:** 10 requests per 15 minutes for a known username (spread over IPs) keep the real user out with the correct password; no admin action ends it.
- **Fix:** count only failures against the per-user bucket (hit after `verifyPassword` fails) or key it by username + IP; keep a higher global per-username ceiling; let admin unlock clear the bucket.
- **Verify:** integration — 10 failures from IP 1, then a correct login from IP 2 succeeds.
- **Tests today:** `tests/integration/phase1.test.ts` lockout and limiter tests — not this case.

### S-04 — Medium — public file route hits the database per request (CONFIRMED, Phase 2a)
- **Evidence:** `src/app/api/v1/files/[id]/route.ts:13-18` (regex check, `getAuthContext()`, `readStoredFile`) — no `enforce`; `src/modules/files/files.service.ts:195-203` caches only publicly readable hits, so every unknown/private id is a query. Rule: `.claude/rules/security.md` "Public, unauthenticated endpoints must be rate limited and must not touch the database on every request".
- **Exploit:** an anonymous loop over random ids keeps Neon compute awake and drains the free compute allowance.
- **Fix:** per-IP rate limit with the memory driver before any database access; short negative cache; or, for anonymous callers, only look up ids equal to the cached public logo id.
- **Verify:** route test — 100 anonymous unknown ids → bounded service calls, then 429.

### S-05 — Medium — integration tests have no target-identity guard (THEORETICAL)
- **Evidence:** `tests/setup.ts:10-11` `if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;` (a shell value wins over `.env`); `tests/test-scope.ts` gate is flag + non-empty URL only. Suites delete sequence counters (`admission-approval.test.ts` afterAll) and overwrite the school profile (`settings-files.test.ts`). S8 relied on manual identity checks before every run; nothing enforces them.
- **Fix:** an integration global setup reusing `src/lib/db-target-guard.ts` — shell-clean check, `TEST_TARGET_BRANCH_ID` / `TEST_TARGET_ENDPOINT_ID` allow-list, refuse development and `FORBIDDEN_*`, live `IDENTITY_SQL` before any test.
- **Verify:** unit tests for the guard (shell override, development endpoint, forbidden endpoint refused).

### S-06 — Medium — e2e setup can create Super Admins anywhere (THEORETICAL, Phase 1)
- **Evidence:** `tests/e2e/global-setup.ts:19` `if (/prod/i.test(url)) throw …` is the only guard (Neon hosts don't contain "prod"); `:25` deletes `e2e-%` users; `:38-45` inserts SUPER_ADMIN users via raw SQL (no `lockSuperAdminGuard`, no audit); `:49` `DELETE FROM rate_limit_bucket` (clears all lockouts); no teardown.
- **Fix:** same allow-list + live-identity guard as the seed; refuse `FORBIDDEN_*`; teardown removing `e2e-%` users; audit or go through the service.

### S-07 — Medium — audit log mutable at the database (CONFIRMED, known KI-024)
- **Evidence:** no migration contains a REVOKE or trigger for `audit_log`; app code never updates/deletes it (grep clean). Docs (`SECURITY.md`, `DATABASE_SCHEMA.md`) state "no UPDATE/DELETE grants" — not implemented.
- **Fix (migration — needs approval):** `BEFORE UPDATE OR DELETE` trigger raising an exception, plus a least-privilege runtime role.

### S-08 — Low — scopes ignored outside students/academic (CONFIRMED with a custom role)
- **Evidence:** `src/lib/rbac/authorize.ts` returns the scope but e.g. `roll-numbers.service.ts` (`authorizeAny`, `authorize(…"rollnumber.*")`), `academic.manage`, settings, users, roles, documents and `admission.create/approve` calls discard it; `identity.schemas.ts` `setRolePermissionsSchema` and `permission-editor.tsx` accept any scope for any permission.
- **Exploit:** a custom role with "Generate roll numbers: Assigned only" acts on every section.
- **Fix:** per-permission `allowedScopes` in `catalog.ts`, enforced in the schema/service and the editor; or `authorizeAll()` for services without a scope policy.

### S-09 — Low — stale class-teacher link after a role change (CONFIRMED)
- **Evidence:** eligibility checked only at assignment (`sections.service.ts:283-292`); `users.service.ts` role changes don't clear `section.classTeacherId`; TRANSPORT_MANAGER holds `["student.read", "ASSIGNED"]` (`catalog.ts`), and `studentScopeWhere` ASSIGNED = class-teacher sections.
- **Fix:** clear `classTeacherId` (non-closed sessions) in the same transaction when a user loses TEACHER/CLASS_TEACHER, or refuse the change; and/or require an eligible role in the ASSIGNED filter.

### S-10 — Low — private PDFs inline on the generic file route (CONFIRMED)
- **Evidence:** `src/app/api/v1/files/[id]/route.ts:7` `INLINE_TYPES` includes `application/pdf`; `:19` disposition inline; no CSP (`src/proxy.ts` skips `/api/`). Reachable for Super Admin (any private file). Dedicated routes use `privateFileResponse` (`src/lib/http/file-response.ts`) with sandbox + attachment.
- **Fix:** use `privateFileResponse` whenever the file isn't publicly readable. **Verify:** `files-route.test.ts` asserts attachment + `content-security-policy: sandbox` for a private PDF.

### S-11 — Low — CSV `;` bypass (CONFIRMED)
- **Evidence:** `src/lib/csv.ts:9` `FORMULA_START = /^[=+\-@\t\r]/` (start of cell only); `:15` quotes only on `[",\r\n]`; class names allow `/^[ -~]+$/` (`academic.schemas.ts:45`) and are exported.
- **Exploit:** a School Admin names a class `Class 1;=HYPERLINK("http://x","Open")`; Excel/LibreOffice with `;` as list separator evaluates the second cell.
- **Fix:** quote cells containing `;` (or quote every cell) and prefix `'` when any `;`/`,`/tab segment starts with a formula character; optionally tighten class-name characters. **Verify:** unit `csvCell("a;=1+1")` is quoted/neutralized.

### S-12 — Low — roll-number sheet without `student.read` (CONFIRMED)
- **Evidence:** `src/modules/students/roll-numbers.service.ts:73-96` `getRollNumberSheet` → `authorizeAny(ROLL_PERMISSIONS)` only; returns names, student codes, and a preview with `dob`. No default role is affected (all roll-number holders have `student.read` ALL).
- **Fix:** require `student.read` ALL in roll-number reads/writes; drop `dob` from the returned preview.

### S-13 — Low — shared guardian edits across sections (CONFIRMED, documented design)
- **Evidence:** `students.service.ts` `updateGuardian` checks the student's scope and the link, then updates the shared `Guardian` row; `Guardian` has no `version` column. Guardian phone is the key for sibling linking at approval (`resolveGuardianLinks`).
- **Fix (owner decision):** require ALL-scope `student.update` when the guardian has links outside the caller's scope, or confirm the current behaviour; add a `version` column (migration).

### S-14 — Low — maker-checker by role only (CONFIRMED, matches D2)
- **Evidence:** `admissions.service.ts` `approveApplication` never compares `createdById` with the approver; School Admin holds `admission.create` and `admission.approve`.
- **Fix (owner decision):** refuse self-approval except Super Admin, or require a second approver when `duplicateOverride` or a guardian link is used.

### S-15 — Low — private blobs never purged (CONFIRMED)
- **Evidence:** `files.service.ts` comment "blob removal is left to housekeeping" — no such job; `discardUpload` swallows delete errors; `deleteDraft` removes retired document rows while `stored_file` rows and blobs remain.
- **Fix:** cleanup job deleting blobs of retired files after a grace period and unreferenced blobs; log discard failures; KNOWN_ISSUES entry.

### S-16 — Low — login timing and counter race (CONFIRMED, Phase 1)
- **Evidence:** `auth.service.ts:39-60`: unknown/locked users get only `burnPasswordCheck`; active users with a wrong password also run a transaction (measurable). `:51` `failed = user.failedLoginCount + 1` from a pre-check read — parallel guesses write the same value.
- **Fix:** equalize the write (or move it to `after()`); atomic `UPDATE … SET failed_login_count = failed_login_count + 1 RETURNING`.

### S-17 to S-22 — Low
- **S-17** `src/lib/audit.ts:5-31` exact-key redaction; add `salary` and case-insensitive substring matching (aadhaar, pan, bank, ifsc, medical, salary, password, token, secret); serialize `Decimal` as string. No current exposure (no such fields in Phase 2B).
- **S-18** `prisma.config.ts` + `package.json` `db:migrate`/`db:deploy` call Prisma directly — wrap them in a guarded script (shell-clean + endpoint allow-list), like the seed.
- **S-19** `scripts/db-check.ts:77,178`, `scripts/cleanup.ts:9` print `(e as Error).message` — route through the existing `sanitize`.
- **S-20** `.claude/settings.json` deny list covers specific `.env` names for Read/Edit only — a generic `.env.*` pattern and Bash readers are not covered. **Configuration change — owner decision; not changed.**
- **S-21** `src/app/api/v1/documents/preview/route.ts` — add a per-user rate limit or cache per branding version.
- **S-22** `src/lib/crypto.ts` AES-GCM without AAD; `files.service.ts` doesn't compare `sha256` on read — bind the storage key as AAD and verify the hash.

## 3. Info / hardening (S-23)

- Session renewal never reaches the cookie (staff signed out 8 h after sign-in — fails safe) (`session.ts`, `context.ts`).
- `createUser` can grant SUPER_ADMIN without `lockSuperAdminGuard` (invariant not at risk; rule 17 wording) (`users.service.ts`).
- Per-IP limits trust `X-Forwarded-For` — document the proxy requirement (`client-ip.ts`).
- Class Teacher sees all session/class/section names in filters and guardian sibling counts (`students.service.ts` `studentFilterOptions`, `_count`).
- Export audit stores the free-text search `q` (often a child's name) (`students.service.ts` export audit) — record its presence/length only.
- Export: `request.text()` uncapped after the Content-Length check; `count` and `findMany` not in one snapshot (a concurrent insert could make `take: 5000` truncate) (`students/export/route.ts`, `exportStudentRows`).
- Upload route puts the raw (invalid) id into the redirect `Location` (same-origin path only) (`admissions/[id]/documents/route.ts:25-30`).
- Sequence keys ignore the literal format — two counters can render the same ID; the unique index prevents duplicates but the violation surfaces as a generic error (`sequence.ts:62-68`).
- Other admission transactions have no `lock_timeout` (availability only); `guardianMatches` lists soft-deleted students; private downloads aren't rate limited (audited); HSTS `preload` hard-coded.
- Audit payloads contain old/new phone, email, address and free-text reasons — permitted by design §4.3; gate their display when an audit viewer is built.

## 4. Test coverage of security controls

| Control | Covered by | Gap |
|---|---|---|
| Authorize-before-data, RBAC matrix | `rbac.test.ts`, `rbac-matrix.test.ts`, `student-rbac.test.ts`, `identity-policy.test.ts`, integration `phase1`, `identity-admin` | Non-ALL scopes on unscoped services (S-08) |
| Student IDOR / scope | `student-records.test.ts` (unit + integration), `student-routes.test.ts`, `ki058-not-found-status.test.ts`, S8 browser + HTTP checks | Closed session (S-02), role change (S-09), cross-section shared guardian (S-13), `countStudentsByStatus` under ASSIGNED |
| Field-level edits / strict schemas | `student-records.test.ts`; integration `student-records` | — |
| Approval concurrency, IDs, capacity, guardian links | `admission-approval.test.ts` (incl. 50 concurrent), `student-registration-rules.test.ts`, `sequence.test.ts` | No deadlock test of approval vs class deactivation / session status change |
| Uploads (CSRF, size, type, photo) | `upload-http.test.ts`, `document-routes.test.ts`, `student-photo.test.ts`, `storage.test.ts`, `files-service.test.ts` | Auth-before-body, body deadline (S-01) |
| Downloads (owner binding, headers) | `files-service.test.ts`, `files-route.test.ts`, `student-routes.test.ts`, `document-routes.test.ts` | Generic route PDF sandbox (S-10); rate limit (S-04) |
| CSV export | `student-records.test.ts`, `student-routes.test.ts`, integration `student-records` | `;` separator (S-11) |
| Audit | `audit-fixes.test.ts` | Variant key names (S-17); DB-level immutability (S-07) |
| Headers / CSP / errors | `audit-fixes.test.ts` (CSP), `db-errors.test.ts`, `identity-misc.test.ts` | `next.config.ts` security headers not unit-tested |
| Environment separation | `db-target-guard.test.ts`, `env-check.test.ts`, `test-scope.test.ts`, `backup-drill.test.ts`, `setup-env.test.ts` | Integration / e2e target guards (S-05, S-06); CLI migrate guard (S-18) |

## 5. Recommended handling (owner decision)

**Fix before closing Phase 2B** (small, code + tests only, no migration): S-01, S-02, S-09, S-10, S-11, S-12, and the export items in §3 (`q` in audit, capped body read, count/rows in one snapshot). **Plus S-05**, because integration runs against Neon are now part of the workflow.

**Owner decisions:** S-13 (shared guardian edits; `version` column = migration), S-14 (self-approval), S-07 (audit trigger = migration), S-20 (Claude settings).

**Track as known issues (pre-existing, Phase 1 / 2a or Phase 10):** S-03, S-04, S-06, S-08, S-15, S-16, S-17, S-18, S-19, S-21, S-22 and the remaining §3 items — S-03 and S-04 are Medium and worth scheduling soon (S-04 is a project-rule violation on a public endpoint).

## Appendix A — S-15 proposal: private file deletion lifecycle (not implemented)

**Today:** replacing or removing a document sets `student_document.deleted_at` and retires its `stored_file` (`deleted_at`) in the same transaction; the encrypted blob stays in private storage indefinitely; `deleteDraft` hard-deletes the draft's document rows while their `stored_file` rows and blobs remain; a crash between writing a blob and committing leaves an untracked blob; `discardUpload` swallows delete errors.

**Proposed lifecycle**
1. **Live** — referenced by a current document/photo (or the school logo).
2. **Retired** — `stored_file.deleted_at` set (replace, remove, draft deletion; also rows whose owner row no longer exists). Already unreadable by anyone.
3. **Purge-eligible** after a grace period — proposal **30 days** (time to correct a mistaken removal and for incident investigation).
4. **Purged** — a scheduled job deletes the blob, then sets a new `stored_file.purged_at` (migration) and keeps the metadata row (id, purpose, owner, size, sha256 — no content) so the audit trail stays resolvable; one `file.purge` audit entry per batch with counts and ids only.
5. **Orphan reconciliation** — blobs under the private root with no `stored_file` row and older than 24 h are deleted (crash leftovers); rows whose blob is missing are reported, never auto-fixed.

**Safety:** dry-run mode first; batch limits; deletes only keys matching the strict storage-key pattern under the private root; failures logged by error name and counted (including the failures `discardUpload` swallows today); no content or names in logs.
**Retention of live documents** (owner/legal decision, KI-004, DPDP Act): keep while the student record exists; after a student leaves or is soft-deleted, retain for N years per school policy, then retire → purge.
**Backups:** purged blobs remain in older backups until backup rotation — the backup retention period must be documented (Phase 10).
**Needs:** owner decisions (grace period, retention period), a migration (`purged_at`), and approval for the job's first dry run.

## Appendix B — S-07 design: database-level append-only `audit_log` (migration NOT created)

```sql
-- Migration draft (not created): 2026111x_audit_log_append_only
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
-- Rollback (comment only):
--   DROP TRIGGER audit_log_no_truncate ON audit_log;
--   DROP TRIGGER audit_log_no_update_delete ON audit_log;
--   DROP FUNCTION audit_log_append_only();
```
- **Effect:** every UPDATE, DELETE or TRUNCATE of `audit_log` fails while the triggers are enabled; INSERT and SELECT are unaffected. Application code never updates or deletes audit rows (verified by grep); the e2e setup/teardown and the integration cleanups only insert. Prisma does not model triggers → no schema drift.
- **Limits:** on Neon Free the app currently connects as the database owner, who can still `DROP` or `DISABLE` the trigger — so this protects against bugs and casual misuse, not a full SQL compromise. Full protection needs KI-024's least-privilege runtime role (INSERT/SELECT only on `audit_log`; migrations as the owner) — Phase 10.
- **Future retention/erasure** (DPDP) would go through an owner-run, audited maintenance procedure that disables the trigger inside one transaction — never through an application code path.
- **Verification:** `db:check` asserts both triggers exist; an integration test asserts UPDATE/DELETE/TRUNCATE are refused and INSERT works; the backup-drill restore (inserts only) still passes.
- **Rollout:** create with `--create-only`, owner review of the SQL, apply to development and then Test with separate approvals (the Phase 2B procedure); never production without approval.

## Appendix C — S-20 proposed `.claude/settings.json` change (NOT applied)

Claude Code applies **deny rules before allow rules**, so a generic `Read(./.env.*)` would also block `.env.example`, which documentation work must read and edit. The proposal therefore lists the additional names explicitly and adds the common shell "print a file" commands for the real secret files:

```diff
     "deny": [
       "Read(./.env)",
       "Read(./.env.local)",
       "Read(./.env.*.local)",
       "Read(./.env.development)",
       "Read(./.env.production)",
       "Read(./.env.test)",
+      "Read(./.env.staging)",
+      "Read(./.env.preview)",
+      "Read(./.env.e2e)",
       "Edit(./.env)",
       "Edit(./.env.local)",
       "Edit(./.env.*.local)",
       "Edit(./.env.development)",
       "Edit(./.env.production)",
       "Edit(./.env.test)",
+      "Edit(./.env.staging)",
+      "Edit(./.env.preview)",
+      "Edit(./.env.e2e)",
+      "Bash(cat .env)", "Bash(cat .env.test)", "Bash(cat .env.local)", "Bash(cat .env.restore.local)",
+      "Bash(type .env)", "Bash(type .env.test)",
+      "Bash(more .env)", "Bash(more .env.test)",
+      "Bash(head .env:*)", "Bash(head .env.test:*)", "Bash(tail .env:*)", "Bash(tail .env.test:*)",
+      "Bash(Get-Content .env:*)", "Bash(Get-Content .env.test:*)",
       "Read(./**/*.pem)",
```

**Effect on development workflows**
- **Unchanged:** `npm run …` scripts; `node --env-file=.env …` and `--env-file=.env.test` (the file is passed to a process, never shown); Next.js and Prisma loading `.env`; reading and editing `.env.example`; `git` (`.env*` is git-ignored).
- **Blocked for Claude Code:** displaying the secret files with the listed commands, and the Read/Edit tools on the additional file names. The owner still edits `.env` / `.env.test` in an editor.
- **Limit:** Bash rules are prefix matches — they stop the common commands, not every possible reader (`grep`, `sed`, a script). The real control remains the project rule "never read `.env*`" plus no secrets in the repository. A stricter alternative (a `Bash(*.env*)`-style pattern) would also block the legitimate `--env-file=` commands and is not recommended.
