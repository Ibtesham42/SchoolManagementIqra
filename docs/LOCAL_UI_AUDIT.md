# Local UI Audit

## 1. Audit date
2026-11-08

## 2. Environment and browser details

| Item | Value |
|---|---|
| Server | `npm run dev` (Next.js 16.4.5, Turbopack) at **http://localhost:3000**, Node 26.13.0 (portable, SHA-256 verified) |
| Database | **None.** `DATABASE_URL` is a labelled placeholder on a closed local port (`127.0.0.1:1`); no Neon, no migrations, no seed |
| Env | Values passed to the dev process only (no `.env` file); ephemeral random keys; `EMAIL_PROVIDER=log`, `AI_PROVIDER=none`, `RATE_LIMIT_DRIVER=memory`. Startup env validation ran and passed |
| Browser | Playwright 1.65, Chromium (Chrome for Testing 158), headless |
| Viewports | Desktop 1280×800 (fine pointer) · Tablet = iPad (gen 7) descriptor, 810×1080, touch · Mobile = Pixel 7 descriptor, touch |
| Tools | axe-core 4.14 (all rules), custom checks (overflow, touch targets, landmarks, first-Tab focus, console errors), screenshots reviewed manually |
| Limits | WebKit/iPhone not used in this audit (covered by the existing e2e suite runs). ERP screens need a signed-in session → database → **not rendered** |

## 3. Pages inspected (16 routes)

| Route | How inspected |
|---|---|
| `/`, `/login`, `/forgot-password`, `/reset-password`, unknown path (404) | Rendered in browser at 3 viewports; axe; functional checks |
| `/erp`, `/erp/users`, `/erp/users/new`, `/erp/users/[id]`, `/erp/roles`, `/erp/roles/new`, `/erp/roles/[id]`, `/erp/account`, `/erp/change-password` | Unauthenticated access verified (all redirect to `/login`); **UI reviewed in code only** |
| `GET /api/health`, `GET /api/health?deep=1`, `POST /api/cron/cleanup` | HTTP checks (200 / 401 / 401 without secret) |

## 4. Existing working features (evidence below)
Public placeholder homepage, sign-in form (validation + generic errors), forgot-password (validation, neutral confirmation, rate limit), reset-password (fragment token handling, invalid-link state), 404 page, auth redirects for every ERP route, health liveness, CSP header, responsive layouts of these pages.

## 5. Visually verified (screenshots reviewed)
- Homepage, login, forgot-password, reset-password (invalid link state), 404 — desktop, tablet, mobile.
- Consistent card layout, readable typography, no clipping or horizontal scroll at any viewport.
- Tablet controls are 44 px tall after fix U1 (login screenshot).

## 6. Functionally verified (browser-driven, no database needed) — 30 checks × 3 viewports

| Check | Desktop | Tablet | Mobile |
|---|---|---|---|
| Login: empty submit → "Enter your username and password." | ✓ | ✓ | ✓ |
| Login: credentials with no DB → generic "Something went wrong", no internals in page | ✓ | ✓ | ✓ |
| Login: "Forgot your password?" → `/forgot-password` | ✓ | ✓ | ✓ |
| Login: "Keep me signed in" checkbox toggles | ✓ | ✓ | ✓ |
| Forgot: empty submit → validation message | ✓ | ✓ | ✓ |
| Forgot: submit → neutral confirmation (no enumeration) | ✓ | rate-limited ✓* | rate-limited ✓* |
| Forgot: "Back to sign in" → `/login` | ✓ | ✓ | ✓ |
| Reset: bogus `#token` → "invalid or has expired" | ✓ | ✓ | ✓ |
| Reset: token stripped from the address bar | ✓ | ✓ | ✓ |
| Home: "Portal sign in" navigates to `/login` | ✓ | ✓ | ✓ |
| Unauthenticated access to all 9 ERP routes → `/login` | ✓ (desktop run) | — | — |

\* After repeated audit runs from the same address the forgot-password limiter (5/hour) engaged and showed "Too many attempts. Please try again later." — the intended protection, verified, not a defect. A first-run confirmation was verified separately on desktop (neutral message shown, previous validation alert cleared).

The first run reported this check as failing on all viewports; investigation showed a **race in the audit harness** (it read the old alert before the action finished), not an application bug.

## 7. Database-dependent features — NOT verified (code-reviewed only)

| Area | Implemented in code | Verified? |
|---|---|---|
| Sign-in success, forced password change, logout, session expiry/renewal | Yes | **No** (needs a user). Covered by pending e2e `phase1.spec`, integration tests |
| Dashboard (welcome, roles, quick actions, free-tier usage panel) | Yes | **No** |
| Sidebar / bottom navigation active states, skip link | Yes | **No** (rendered only inside the authenticated layout) |
| Users: list, search, status filters, pagination, empty state, create (one-time temporary password), edit name/email/roles, deactivate/reactivate, admin password reset, unlock, sign out all sessions | Yes | **No** — pending `admin.spec` + `identity-admin.test` |
| Roles: list, create, rename, permission × scope editor, delete-unused, system-role read-only | Yes | **No** — pending |
| My account: roles, change password, sign out other devices | Yes | **No** |
| Confirmation dialogs, success/error banners, one-time-secret copy | Yes | **No** |
| Reset completion with a real token, email delivery (log outbox) | Yes | **No** — pending integration test |
| "Not permitted" screen for missing permissions | Yes | **No** (needs a signed-in user lacking permission) |

## 8. Broken features
None found on the inspected, database-independent pages. (Nothing is claimed about the database-dependent screens.)

## 9. Missing pages (not implemented)
- **Profile management**: users can't edit their own display name/email (only an admin can). *Not invented here — recorded for a later phase.*
- **Session/device list** (which devices are signed in): only "sign out other devices" exists.
- **Audit-log viewer** (`audit.read` exists, no UI).
- **School settings & academic sessions UI** (scheduled at the start of Phase 2 — DEVELOPMENT_ROADMAP).

## 10. Placeholder pages
- `/` — shows the configured school name (fallback "School" without a database) and a sign-in link; the real website is Phase 8.
- Dashboard text "ERP modules are added phase by phase" — honest placeholder for future modules.

## 11. Desktop UI issues
- None blocking. Controls are compact (36 px) with a mouse — intended (UI_UX_GUIDELINES).
- The dev-tools "N" badge in screenshots is Next.js development-only UI.

## 12. Tablet UI issues
- **U1 (fixed):** controls switched to compact 36 px at ≥ 640 px width even on touch tablets (below the 44 px rule). Now compact only with a fine pointer (`sm:pointer-fine:`); tablets keep 44 px. Re-audit: no sub-44 px controls on tablet except the visual 16 px checkbox, whose row/label (≥ 44 px) is the tap target.

## 13. Mobile UI issues
- None found on the inspected pages (no overflow, all controls ≥ 44 px, readable text).

## 14. Accessibility findings
- axe: **0 serious/critical** violations on all inspected pages at all viewports (before and after fixes).
- **U2 (fixed):** the default 404 page had no `<main>` landmark (axe moderate `landmark-one-main`, `region`) and no way back; now a styled page with `<main>`, heading and links — axe clean.
- Every page has one `<h1>`, one `<main>`, `lang="en"`; first Tab lands on the first control with a visible focus ring; no images without `alt`.
- Checkbox visual size 16 px; the label is clickable and the row is ≥ 44 px (acceptable; noted).

## 15. Fixes completed
| ID | Fix | Verified by |
|---|---|---|
| U1 | Touch targets: compact sizes only for wide screens **with a fine pointer** (button, input, select, user filter chips, permission scope select); sidebar links 44 px on touch | Re-audit (tablet/mobile: all ≥ 44 px) |
| U2 | Styled 404 page with landmark, heading and links | Re-audit (axe clean, screenshot) |
| U3 | ERP loading state (`src/app/erp/loading.tsx`, skeleton with `role="status"`) | Build/typecheck; **visual check pending DB** |
| U4 | Dates shown in the school time zone (`lib/format.ts`, default `Asia/Kolkata`) instead of the server's — a UTC server would have shown Indian schools times 5½ h off | Code review; typecheck; **visual check pending DB** |

## 16. Outstanding issues
- All database-dependent UI (§7) — needs Neon `development`/`test` (KI-001/KI-016/KI-026).
- Time zone default is hard-coded to the settings default until settings are read (KI-032).
- Missing pages in §9.

## 17. Recommended improvements
1. After Neon is configured, run `admin.spec`/`phase1.spec` on desktop, tablet and phone and repeat this audit for every ERP screen (screenshots + axe).
2. Add a tablet project (`iPad (gen 7)`) to `playwright.config.ts` — currently desktop, Pixel 7, iPhone 14.
3. Self-service profile editing and a device list (later phase, with tests).
4. Read the time zone from `SchoolSetting.timezone` when the settings UI lands (Phase 2).

## 18. Phase 1 completion assessment
**Not complete.** Everything that can be verified without a database passes (unit 1,263; offline e2e; this audit). The ERP screens and all database flows are implemented but **unverified** until Neon is configured and the pending integration/e2e tests pass.

## 19. Phase 2 readiness assessment
**Not ready to start.** Prerequisites: Phase 1 database verification; then settings/academic-session UI, private file storage and PDF generation at the start of Phase 2 (DEVELOPMENT_ROADMAP §4).

## 20. G7 — connected to Neon development (2026-11-09)

**Environment:** fresh `npm run dev` (Next.js 16.4.5, Node 26.13.0) at http://localhost:3000, started 15:55Z UTC from a shell with no database/env overrides; Next reported `Environments: .env` only. `.env` endpoint fingerprint = development (`7e8febb9`); live read-only identity = development branch/endpoint. A stale dev server from the 2026-11-08 offline audit was stopped by the owner first. Playwright 1.65 Chromium, 360×780, 768×1024 (also touch), 1280×800. No sign-in, no form submitted.

### Signed-out checks (Claude) — all passed
| Check | 360 | 768 | 1280 |
|---|---|---|---|
| `/login`, `/forgot-password` render (h1 "Sign in" / "Reset your password"), no console errors | ✓ | ✓ | ✓ |
| `/erp`, `/erp/settings`, `/erp/settings/sessions`, `/erp/users` signed out → redirected to `/login` | ✓ | ✓ | ✓ |
| No horizontal scroll | ✓ | ✓ | ✓ |
| Inputs and buttons 44 px on touch (360 px; 768 px with touch); compact 36 px only with a fine pointer (intended, U1) | ✓ | ✓ | n/a |
| Every visible input labelled (the only unlabelled one is Radix's `aria-hidden` native checkbox mirror) | ✓ | ✓ | ✓ |

API and headers (signed out): `GET /api/v1/documents/preview` → **401** `UNAUTHENTICATED`; `GET /api/v1/files/<random uuid>` and `/api/v1/files/not-a-valid-id` → **404** `NOT_FOUND` (JSON, no stack trace); `/login` headers: nonce CSP with `strict-dynamic` (`unsafe-eval` present only in development, for React Refresh), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.

Database before/after (read-only counts on development): user 1, session 0, audit_log 2 (newest 14:13:45Z, the seed), school_setting 1, academic_session 0, rate_limit_bucket 0, stored_file 0, password_reset_token 0 — **unchanged**. Dev-server log: no errors.

Observation (not a defect for local dev): `next dev` also listens on the LAN address (Network: 172.20.10.x:3000). Use a trusted network during G7, or run `next dev -H 127.0.0.1`.

### Signed-in checks (owner-approved; Claude-driven, owner entered the password) — in progress
Server on 127.0.0.1:3000 only. Screenshots: scratchpad `g7/shots-signed-in`.

| # | Result | Evidence |
|---|---|---|
| J2 | ✓ | forced change enforced on every ERP page until done; DB `must_change_password` false, `auth.password_changed` |
| J3 | ✓ 23/23 | 7 screens × 360/768/1280: no horizontal scroll, 44 px on touch, More sheet, focus ring, no console errors |
| J4 | ✓ | PIN, https website and hours errors; "Please correct the highlighted fields."; nothing written |
| J5 | ✗ → fixed (B1, KI-049) → **✓ 2026-11-10** | re-test after reboot: Asia/Kolkata pre-selected, no `Asia/Calcutta` option; first save correctly rejected (seeded profile had no address: street/city/state/PIN errors, nothing written); saved with obviously fake placeholder address → "School profile saved."; Asia/Kolkata, en-IN, INR, DD/MM/YYYY persist after reload; 1 `settings.profile_update` audit row |
| J6 | ✓ | "Logo updated." |
| J7 | ✓ type, ✓ 900 KB; ✗ 1.4 MB → fixed (B2, KI-048) → **✓ 2026-11-10** | 1.4 MB file: "The file is 1.4 MB; the limit is 800 KB." on choose and on submit; no POST sent; logo, `stored_file` and storage files unchanged |
| J8 | ✓ | "No logo" placeholder |
| J9 | ✗ 2026-11-10 → fixed in code (B3 KI-050, B4 KI-051) → **✓ re-run 2026-11-10** | First run: A4, logo, name, address, `private, no-store`, no personal data ✓; **footer drawn at y ≈ 6217 pt (page is 842 pt) — "Generated …" and "Page X of Y" not visible (B3)**; "Settings → School profile" printed as "Settings ' School profile" (B4). **Re-run** (same server process, hot-reloaded, no restart; no database writes — counts unchanged): 200 `application/pdf`, `private, no-store`, inline; 1 page 595.28 × 841.89 pt (210 × 297 mm); 200×200 logo, "Demo Public School", placeholder address; footer baseline 23.5 pt (top 31 pt, inside the 56 pt bottom margin; lowest body line 476.5 pt — no overlap) reading "Demo Public School · Generated 10 Nov 2026, 12:58 am" (request at 19:28 UTC = Asia/Kolkata) and "Page 1 of 1"; text "Settings > School profile"; only school settings data, no personal data; checked visually in a rendered page image as well as by text coordinates |
| J10 | **✓ 2026-11-10** (accepted by the owner on this evidence) | 2026-27 created 1 Apr 2026 – 31 Mar 2027 as **Planned**; dates shown without a day shift at 360/768/1280; DB `2026-04-01..2027-03-31`; audit `session.create` |
| J11 | **✓ 2026-11-10** | overlap → "These dates overlap with session 2026-27."; name/date mismatch → "Dates must fall in 2029–2030 to match "2029-30"." + field error "Dates don't match the name."; non-consecutive name rejected; nothing written. Observation (not a defect): after a rejection the New session form clears the values typed |
| J12 | **✓ 2026-11-10** | edit while Planned (end date changed and restored — 2 `session.update`); Activate → **Active**, edit form gone, actions Make current + Close; Make current (confirm dialog) → badges **Active + Current**, **no actions** for the current session (Close not offered); Settings shows "Current session: 2026-27"; no console errors. Run 2 stopped after Activate had succeeded (stop reason not saved; screenshot shows Active); run 3 resumed from a fresh load and passed |
| J13 | ⚠ interrupted 2026-11-10 19:36Z | synthetic account `g7.demo.schooladmin` (SCHOOL_ADMIN) created by the Super Admin (audit `user.create`); the test process then hit **"Fatal process out of memory"** (≈2 GB free) before sign-in; the dev server was no longer listening. The one-time password existed only in process memory (never written), so it is lost; the account was never signed in to. Owner approved: reboot, then reuse the account via Super Admin **Reset password**; J13 and J14 as separate small runs. **Run 2** (19:55Z, after reboot): reset ✓, forced change ✓, → `/erp` ✓, **✗ menu showed only Dashboard / My account** although SCHOOL_ADMIN holds `user.read`, `settings.read`, `settings.manage` (read-only grant check: 36 grants) — **bug B5 (KI-052)**, fixed in code (`revalidatePath("/erp", "layout")` in `changePasswordAction`). **Run 3 ✓ 2026-11-10 20:22Z** (fresh `next dev -H 127.0.0.1`, 2.37 GB free; identity + baseline read-only first): Super Admin Reset password → one-time password (14 chars, never recorded, masked in screenshot); fresh context sign-in forced to `/erp/change-password`; change → `/erp`; menu **Dashboard, Users, Settings, My account** (no Roles); settings profile form, logo upload and PDF preview present, time zone Asia/Kolkata (nothing saved); sessions page with Create session and 2026-27 (nothing created); Users list without New user; `/erp/users/new` and `/erp/roles` → not permitted; own user detail without management actions; no console errors. DB writes exactly `user.password_reset_by_admin`, `auth.login`, `auth.password_changed` (audit 21 → 24; session 3 unchanged — the reset revoked the earlier School Admin session); nothing else changed; dev log 0 errors. Not covered: the Super Admin's detail page as seen by the School Admin (link not matched by the script) |
| J14 | **✓ 2026-11-10 20:26Z** | Super Admin created synthetic `g7.demo.teacher` (TEACHER) → "Account "g7.demo.teacher" created." + one-time password (14 chars, never recorded, masked); fresh context sign-in forced to `/erp/change-password`; change → `/erp`; menu **Dashboard, My account** only; `/erp/settings`, `/erp/settings/sessions`, `/erp/users`, `/erp/users/new`, `/erp/roles` → not permitted; `GET /api/v1/documents/preview` → **403** `FORBIDDEN` JSON (no stack); `/erp/account` reachable; no console errors. DB writes exactly `user.create` (after = id, username, displayName, roleKeys, email null — no secret), `auth.login`, `auth.password_changed` (audit 24 → 27, user 2 → 3, session 3 → 4) |
| J15 | **✓ 2026-11-10** | signed out: current logo `GET /api/v1/files/<logo id>` → 200 `image/png` (PNG signature, 687 bytes), `public, max-age=86400, immutable`, `nosniff`; retired logo id, random 24-char id and `not-a-valid-id` → 404 `NOT_FOUND` JSON "File not found." (no stack). No DB writes (counts unchanged) |
| Clean-up | **✓ 2026-11-10 20:31–20:32Z** (accepted by the owner as PASS) | Super Admin deactivated `g7.demo.schooladmin` and `g7.demo.teacher` (confirm dialog "Deactivate this account?"). Run 1 stopped at a false negative: the script read the page before the in-place update arrived, while the database already showed the account inactive with 0 sessions. Run 2 waited for the update: "Account deactivated and signed out everywhere." appeared ~5 s after confirming (dev server); after reload both show **Inactive**, Reactivate offered, Active sessions 0; no console errors. DB: 2 × `user.deactivate` (`{isActive:true}` → `{isActive:false}`), audit 27 → 29, session 4 → 2 (both demo sessions revoked); both demo users `is_active = false` |
| J16 | **✓ 2026-11-10** (owner-authorised read-only run by Claude, in place of the owner's SQL-editor run) | The three J16 queries ran in one `BEGIN READ ONLY … ROLLBACK` transaction after a pre-connect endpoint check. **Q1:** project SchoolMang (`flat-field-93552132`, confirmed read-only via `neon projects get`), branch `br-morning-scene-aoxm8ctk`, endpoint `ep-quiet-river-aoywr8xg`, `transaction_read_only = on`, db `neondb`, Postgres 18.6; not forbidden, not test. **Q2:** 15 actions / 29 rows, 0 mismatches against the expected table (now including `user.deactivate` 2). **Q3:** 17 rows with before/after scanned in-process (values not printed): no password fields, hashes, tokens, Aadhaar/PAN/bank/salary values; 3 `user.create` rows flagged only for the key name `roleKeys`, whose values were confirmed read-only to be role names (SUPER_ADMIN, SCHOOL_ADMIN, TEACHER) — false positives; `settings.profile_update` holds school contact data (fake placeholders), not personal data; no `[REDACTED]` markers yet because no sensitive field has been audited. Earlier pre-check (27 rows): actions `auth.login` 5, `auth.password_changed` 4, `file.retire` 1, `file.upload` 2, `seed.apply` 1, `session.create` 1, `session.set_current` 1, `session.status_change` 1, `session.update` 2, `settings.logo_remove` 1, `settings.logo_update` 2, `settings.profile_update` 1, `user.create` 3, `user.password_reset_by_admin` 2; scan of all 27 `before/after` values for secret-named keys, 12-digit (Aadhaar-like) numbers and long tokens: 0 flagged |
| J17 | optional — **not run** (not a failure) | Phase 1 database e2e suite (33 tests) needs a production build and a separate owner approval; tracked by KI-016 |
| J18 | ✓ 2026-11-10 | this section and the summary below |

### G7 summary (J18) — PASSED 2026-11-10

**Scope:** Phase 2a signed-in UI verification on Neon `development` only (project SchoolMang, `br-morning-scene-aoxm8ctk` / `ep-quiet-river-aoywr8xg`). Test and production were never connected; the development identity was verified read-only before every write stage. Server: `next dev` on 127.0.0.1:3000 (`.env` only). Runtime: **Node 22.23.4** (system Node; the required Node 26 is not installed yet — KI-009).

| Step | Result |
|---|---|
| J1 + signed-out checks | ✓ |
| J2 forced password change (owner) | ✓ |
| J3 7 screens × 360/768/1280 | ✓ 23/23 |
| J4 profile validation | ✓ |
| J5 profile save / time zone | ✗ B1 → fixed (KI-049) → ✓ |
| J6 logo upload · J8 logo removed | ✓ · ✓ |
| J7 logo type/size | ✗ B2 (1.4 MB) → fixed in the browser (KI-048) → ✓ |
| J9 PDF letterhead | ✗ B3 footer, B4 glyph → fixed (KI-050, KI-051) → ✓ |
| J10–J12 academic sessions | ✓ (owner accepted) |
| J13 School Admin | interrupted (out of memory) → ✗ B5 menu → fixed (KI-052) → ✓ |
| J14 Teacher · J15 signed-out files | ✓ · ✓ |
| Clean-up: both demo users deactivated | ✓ (owner accepted) |
| J16 audit log | ✓ (15 actions / 29 rows; no secrets) |
| J17 DB e2e suite | optional, not run |

**Final development state** (read-only, 2026-11-10 20:45Z): audit_log 29; users 3 — `admin` (SUPER_ADMIN) active, `g7.demo.schooladmin` and `g7.demo.teacher` **inactive**, 0 sessions each; academic session **2026-27 (2026-04-01..2027-03-31) ACTIVE CURRENT**; stored_file 2 (1 live logo, 1 retired), 2 private-storage files on disk; generated_document 0; school setting Asia/Kolkata, en-IN, INR, DD/MM/YYYY, logo set, profile with an obviously fake placeholder address; 2 live sessions (owner).

**Observations (not defects):** the New session form clears the typed values after a rejection (J11); the deactivation message appears ~5 s after confirming on the dev server; `next dev` without `-H` also listens on the LAN.

**Evidence (kept):** Claude session scratchpads under `%LOCALAPPDATA%\Temp\claude\8527fcff745246d5\` — `6c4a8e7a…\scratchpad\g7\` (J1–J12, J9 PDFs and renders, B3, owner browser state), `16c0efda…\scratchpad\` (J13 runs 1–2, `g7b\`), `5796bc74…\scratchpad\g7c\` (J13 run 3, J14, J15, clean-up, J16, final snapshot, Node diagnostic); a dev-server log in each. No credentials were recorded anywhere; one-time passwords are masked in screenshots.

Part B evidence (J10–J13 partial): previous session scratchpad `g7/` — `stage1-*.png`, `stage1-result.json`, `stage1-run3.txt`, `stage1-db-after.txt`, `stage2-db-before.txt`, `stage2-run1.txt`. Development after J10–J12: audit_log 12 → 17 (`session.create` 1, `session.update` 2, `session.status_change` 1, `session.set_current` 1); academic_session 0 → 1 (2026-27 ACTIVE CURRENT). After the interrupted J13: audit_log 18, user 2; session 2, stored_file 2 unchanged.

## 21. S8 — signed-in browser verification plan, Phase 2B S7 screens (PREPARED 2026-11-10 — RUN, see §21.1)

**Status:** approved and run 2026-11-10 — results in §21.1.

**Target:** Neon **Test** branch only (`flat-field-93552132` / `br-purple-credit-aooeex9m` / `ep-quiet-brook-aoktw1hh`). Development and production are never written. A local `next dev` on `127.0.0.1:3001` with `DATABASE_URL`/`DIRECT_URL` taken from `.env.test` for that process only (shell variables are not left set); before the first sign-in a read-only probe proves the server's database is Test (fixture visible on Test, absent on development). Private file storage: no uploads are made in this plan.

**Writes on Test this plan needs (each listed for approval):**
1. Fixture (one script, refuses unless the live server reports the Test branch + endpoint): 7 synthetic users `s8demo.<role>` (School Admin, Principal, Class Teacher, Accountant, Admission Officer, Parent, Student), random throwaway passwords stored only in the session scratchpad, `mustChangePassword` false; academic session `2026-27` (ACTIVE, current); class `S8-5` "S8 Demo Class 5" with sections A (class teacher = `s8demo.classteacher`) and B; 4 students admitted through the real admission services — Ananya / Rohit / Zoya Demo in A, Kabir Demo in B (obviously fake names and phones `97000000xx`, DOB 2016-05-01, admission 2026-06-01); section A roll numbers generated and finalized (1–3).
2. Browser actions that write (audited by the app): 7 sign-ins (sessions); Class Teacher saves Rohit's phone and his guardian's phone; School Admin renames Kabir → "Kabeer", records Zoya as TRANSFERRED on 2026-11-01 (after two refused attempts), runs 2 CSV exports (audit + rate-limit rows).
3. Cleanup afterwards, session-scoped and `s8demo`-prefixed, in one transaction with per-step counts (same procedure as the approved 25-row cleanup) — separate approval.

**No grant changes:** the Test catalog is already the approved 82 / 13 / 271; the plan asserts it is unchanged before and after.

**Method:** Playwright Chromium; one sign-in per role (login rate limit 20/IP/15 min), the session reused for **360×780 (touch), 768×1024 (touch) and 1280×800**; full-page screenshots per role and viewport; checks: no horizontal overflow, touch targets ≥ 44 px at 360, table ≥ md / cards < md.

| Role | Directory (`/erp/students`) | Profile | Editing | Leaving | CSV export | Menu |
|---|---|---|---|---|---|---|
| School Admin | all 4 students; search by name, student ID (lower case), admission no.; filters session / class / section A (3) / B (1) / status; `session=all`; malformed query falls back | all sections (overview, guardians, academic history, documents, status history); roll 1, IDs, guardian; admission link | identity + contact; renaming keeps student ID and admission no.; no ID inputs | future date refused; date before joining refused; valid date → TRANSFERRED, history "Left", **roll 3 retained**, status-history row; status filter finds the student | button posts the filters: section A → 3 rows, BOM, header, left student shows roll 3 + Transferred; section B → 1 row; cross-site POST 403; GET 405; button ≥ 44 px at 360/768 | Students highlighted alone on directory/profile; Roll numbers alone on `/registration` |
| Principal | all 4 | documents section + admission link; no Edit / Record leaving | — | — | no button; POST 403 (no `export.run`) | menu recorded |
| Class Teacher | only section A (3); Kabir (B) absent; Kabir's profile → 404 | own students only | contact only: no first name / DOB inputs; phone saved; guardian form without name, phone saved | `/status` not permitted | no button; POST 403 | menu recorded |
| Accountant | all 4 (read, D8) | readable; **no** documents, admission link, Edit or Record leaving | `/edit` not permitted | `/status` not permitted | no button; **POST 403 (D8)** | exactly Dashboard · Students · My account; `/erp/admissions` not permitted |
| Admission Officer | all 4 | Edit shown, Record leaving not | identity fields shown (ALL) | — | no button; POST 403 | menu recorded |
| Parent | `/erp/students` not permitted at all 3 widths | profile URL not permitted; photo API 404 | — | — | POST 403 | **no Students item** |
| Student | as Parent | as Parent | — | — | POST 403 | **no Students item** |

**Formula-injection protection:** names, phones and emails are validated so they can't start with `=`, `+`, `-`, `@`; the exported columns therefore can't carry a formula from the UI. The CSV escaping (prefix, quoting, BOM, CRLF) is covered by unit tests (`tests/unit/student-records.test.ts`), and the browser run checks the downloaded file's format. **Row limit (5,000):** covered by unit tests and the route test (409 / `too_many`); creating 5,001 students on Test is not planned.

**Evidence:** screenshots (`<role>-students-<width>.png`, School Admin profile/edit at 3 widths, after-leaving), `results.json`, the exported CSVs, Test counts before/after, the development probe before/after (must be unchanged), dev-server log.

**Stop conditions:** any identity mismatch, any Development change, any failed permission check (reported, not worked around), or a catalog difference.

### 21.1 Results — RUN 2026-11-10 on the Neon Test branch: PASSED

Run as planned with one owner-confirmed change: **8 users including Super Admin**. Server proven on Test before any write (§ progress log, part 2). Fixture, browser writes and cleanup on Test only; no Development or Production access.

| Role | 360 px (touch) | 768 px (touch) | 1280 px | Role checks (1280) |
|---|---|---|---|---|
| Super Admin | ✓ 4 students, cards, targets ≥ 44 px, no overflow | ✓ 4 students, no overflow | ✓ table | ✓ full menu (Admissions · Students · Roll numbers · Classes · Users · Roles · Settings); Export button; profile shows documents, admission link, Edit + Record leaving; export POST 200 (4 rows) |
| School Admin | ✓ (+ Export button 44 px, profile and edit form without overflow) | ✓ (same) | ✓ table | ✓ search by name / student ID (lower case) / admission no.; filters section A 3, B 1, class 4, Transferred 0→1, `session=all` 4, malformed query falls back; profile sections, roll 1, IDs, guardian; rename keeps IDs, no ID inputs; leaving: future date and date before joining refused (nothing saved), valid date → Transferred, history "Left" 1 Jun–1 Nov 2026, **roll 3 retained**, status-history row, "already transferred" notice; export button → CSV (BOM, header, 3 rows for section A, Zoya with roll 3 + Transferred), POST section B → 1 row, cross-site POST 403, GET 405; menu highlight: Students alone on directory/profile/edit, Roll numbers alone on `/registration` |
| Principal | ✓ | ✓ | ✓ | ✓ menu Dashboard · Admissions · Students · Roll numbers · Classes · My account; no Export button; profile with documents + admission link, no Edit / Record leaving; export POST 403 |
| Class Teacher | ✓ 3 students (section A only) | ✓ | ✓ | ✓ menu Dashboard · Students · Classes · My account; Kabir (section B) absent; his profile and edit page show "Page not found" with no data (HTTP 200 — KI-058), his leaving page "not permitted"; edit has no first-name/DOB/ID inputs; phone saved; guardian form without name, guardian phone saved; leaving page not permitted; no Export button; export POST 403 |
| Accountant | ✓ 4 students | ✓ | ✓ | ✓ menu exactly Dashboard · Students · My account; profile readable without documents, admission link, Edit or Record leaving; `/edit`, `/status`, `/erp/admissions` not permitted; **export POST 403 (D8)** |
| Admission Officer | ✓ | ✓ | ✓ | ✓ Edit shown (identity fields), Record leaving not; export POST 403 |
| Parent | ✓ "not permitted", no overflow | ✓ | ✓ | ✓ **no Students menu item** (Dashboard · My account); profile URL not permitted; photo API 404; export POST 403 |
| Student | ✓ "not permitted", no overflow | ✓ | ✓ | ✓ same as Parent |

**Counts:** main run 137 checks, 130 passed; the 7 failures were script measurement errors (duplicate highlighted item from the hidden mobile bar; leaving form read before the server-action response; HTTP 200 on a streamed not-found page) — each re-verified against Test data and with corrected checks: **12/12 passed**. Dev-server log: no application errors (two "destination stream errored" lines are the script closing a page mid-response).

**Not covered in the browser (by design):** formula-injection and the 5,000-row limit (unit + route tests; UI validation prevents formula-starting values in exported columns); document downloads (no uploads in this run); photo display (no photos uploaded).

**Evidence (session scratchpad `s8/`):** 24 directory screenshots (8 roles × 3 widths), School Admin profile/edit at 360/768/1280, after-leaving and refused-leaving screenshots, Class Teacher other-section screenshot, `export-section-A.csv`, `results.json`, `followup-results.json`, dev-server log.

**Cleanup:** 62 rows deleted + 1 updated in one transaction (counts in the progress log); Test verified clean; catalog unchanged.
