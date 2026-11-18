# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow SemVer once the first release ships.

## [Unreleased]

### Added (Phase 3A — HR core, in progress)
- Database migration `20261112000000_phase3a_hr_core` (applied to the development and Test databases 2026-11-18): departments, designations, employees with a permanent employee code, teacher profiles, employee documents (one current photo) and append-only service history; a login account can be linked to one employee. Department and designation names accept any script (Hindi, Khasi, other Indian languages and English). No Aadhaar, PAN, bank or medical data is stored.
- The database check (`db:check`) also verifies the HR constraints once the migration is applied; the backup drill restores linked staff accounts correctly.
- Staff (new menu item for School Admin, Principal, Vice Principal, HR Manager and Librarian): staff directory with status counts, search by name, employee ID or phone, and filters (staff type, department, designation, status, appointment type); table on desktop, cards on phones.
- Register employee (School Admin, HR Manager): four steps — personal, contact, employment, review. The permanent employee ID (`EMP-2026-0001`, joining year) is assigned on registration and never changes; teaching or non-teaching comes from the designation.
- Employee profile with an overview for everyone who may see the directory; date of birth, personal contact details, home address, emergency contact and employment dates only for School Admin, Principal, HR Manager and Super Admin (the Librarian and Vice Principal see the directory only). Personal and contact details can be edited.
- Departments and designations (names in any language, e.g. Hindi or Khasi): add, edit, deactivate — never deleted.
- Teacher profile on a teaching employee's page: academic and professional qualifications (up to 10 each), subjects taught (up to 10, any language), experience before joining and registration number.
- Login account panel on the employee page: shows the linked account; a Super Admin can link an existing active account to the employee or unlink it (one account per employee, recorded in the audit log). Linking lets that person see their own staff record (below).
- "My profile" on My account: staff whose login is linked to their staff record can view it read-only — employment, contact details and qualifications. Parents and students have no access to staff records.
- Class teachers: a teacher can be made class teacher only when their login is linked to an active teaching staff record; the teacher list on the Sections page shows only those teachers. Existing class-teacher assignments are not changed.
- Account linking: only an administrator who can see staff personal details may link accounts, and nobody except a Super Admin can link their own account.
- Permissions: staff roles can now read their own staff record. Catalog: 84 permissions, 291 default grants.
- Employment changes (department, designation, appointment type, confirmation), reporting line (no loops) and status — resigned, terminated, retired, long-term leave, rejoined — each recorded with its date in the employee's service history, shown on the profile to staff who may see personal details (and to the employee on My profile).
- Staff overview (`/erp/hr`): current teaching and non-teaching staff, long-term leave and former staff, staff per department and per status; recent joiners and leavers (for staff who may see personal details); current staff without a login and teachers without a class-teacher section this session (for administrators who can see accounts and classes).
- Download the staff directory as CSV (School Admin, HR Manager, Super Admin) with the current filters — directory columns only, at most 5,000 rows, recorded in the audit log.
- Leaving releases the person's class-teacher sections and offers to deactivate their login (an administrator who manages users can do it in the same step; otherwise the screen says it still has to be done). Rejoining keeps the same employee ID. Nobody can change their own employment record.
- Permissions: new "View employee personal details and documents" and "Upload, verify and remove employee documents and photos"; School Admin can now manage staff records. Catalog: 84 permissions, 279 default grants.

### Fixed (CI)
- Five storage modules were missing from the repository because an ignore rule for local file storage also matched the source folder; CI now builds from a clean checkout again.

### Added (Phase 2B — admissions & students, in progress)
- Database (development only): migration `20261111000000_phase2b_admissions_students` — admission applications, applicant guardians, students, guardians, documents, session enrollments, roll-number batches, status history; `school_setting.required_admission_documents` (default photo + birth certificate).
- Admissions screens: application list with status counts and filters, new admission (5 steps, saved as a draft after step 1), application review (start review, assign section, return to draft, reject). Submitting assigns `APP-<session>-<number>` and flags possible duplicate students. Approval and documents follow in the next slices.
- Admission documents and the student photo (step 5 "Photo & documents"): private, encrypted uploads up to 10 MB through a dedicated, same-origin, rate-limited upload route; photos re-encoded by `sharp` (location and other hidden data removed); view, verify and remove with an audit trail. `sharp` 0.35.5 is now a direct dependency.
- Admission approval registers the student in one step: permanent student ID and admission number (session start year), parents/guardians (an existing guardian is linked only when the approver explicitly confirms the same phone number), enrolment in the chosen section with an exact capacity check, and a full audit trail. Possible duplicates need a written reason.
- Database transactions wait up to 10 s for a connection and may run up to 15 s; when the system is busy, users see "The system is busy. Please try again" instead of an error.
- Roll numbers per section (`/erp/students/registration`): alphabetical preview, draft, type-to-confirm finalization; finalized numbers never change automatically — students approved later get the next number; Principal corrections need a reason. New menu item "Roll numbers".
- Students (`/erp/students`): directory with status counts, search by name / student ID / admission number, filters (session — current by default — class, section, status), table on desktop and cards on phones; a class teacher sees only the students of their own section. Student profile (photo, overview, guardians, academic history per session, documents for permitted roles, status history, link to the admission). Edit student details (class teachers: contact details only; student ID and admission number never change) and guardian contact details. "Record leaving" (transferred, withdrawn, graduated) with a date and reason — the student leaves the class, keeps the roll number, and the history is kept. CSV export of the filtered list for School Admin / Super Admin (spreadsheet-safe, at most 5,000 rows, audited, rate limited). New menu item "Students"; the menu now highlights only the most specific item.
- Permission `student.document.manage` (School Admin, Admission Officer); Principal now approves admissions (`admission.approve`) together with School Admin. Catalog: 82 permissions, 271 default grants.

### Security (Phase 2B closure audit, 2026-11-10)
- Document uploads: people who may not upload are refused before the server reads anything; an upload must finish within 2 minutes.
- A class teacher's access to a section's students ends when the session is closed, and when their teacher role is removed; class teachers can now be removed from closed sessions.
- Sign-in limits can no longer be used to keep someone out from another computer; an admin unlock (or a password reset) also clears them.
- The public file address is rate limited and no longer queries the database for every unknown address; private PDFs open as safe downloads.
- Integration and end-to-end tests refuse to write to any database except the explicitly named test branch.
- The role editor only offers scopes the system actually enforces; "own salary" can only be granted for the person's own record.
- CSV export: spreadsheet formulas are also neutralised for semicolon-separated spreadsheets and other edge cases; the export log no longer stores search text.
- Roll-number sheets require permission to read student records.
- Class teachers can't change a parent's details when the parent is also linked to a student in another section (School Admin can).
- The person who created an admission application can no longer approve it; another School Admin or the Principal must.

### Fixed
- ERP pages for a record that doesn't exist (or that the user may not see) now return a real "404 Not Found" status instead of 200. The page content was already the "Page not found" screen; no data was ever shown. The generic loading skeleton during ERP navigation was removed to make this possible.

### Verified (Phase 2B — Neon Test branch, 2026-11-10)
- Test branch migrated (`20261110000000`, `20261111000000`); all Phase 2 and Phase 2B integration suites pass there.
- 50 simultaneous admission approvals pass (179.6 s on the Test branch): 50 distinct student IDs and admission numbers, exact section capacity, no partial registrations. The test now prepares its applications separately, waits for all approvals before cleanup and cleans up by session; admission-approval suite 7 passed, 0 failed.
- Synthetic leftovers of an earlier failed test run removed from the Test branch (25 rows, one transaction, audited). No Development or Production changes.
- Signed-in browser verification of the Students screens is still pending.

### Added (Phase 2 Classes & Sections — offline; migration `20261110000000` NOT applied)
- Classes screen (`/erp/academic/classes`): create, edit, activate/deactivate (never deleted); class code fixed once sections exist; optional per-class default capacity.
- Sections screen (`/erp/academic/sections?session=`): per-session list grouped by class; add several sections at once ("A, B, C, D"); edit name/capacity; activate/deactivate; delete while unused; assign/remove class teacher; copy from another session (no class teachers, idempotent); CLOSED sessions read-only.
- "Default section capacity" (40) on the Settings page; "Classes" menu item (`academic.read` or `academic.manage`).
- `src/modules/academic/`: schemas, pure rules, scope policy, classes and sections services (row locks, optimistic `version`, audit in the same transaction).
- New permission `academic.read` (81 permissions, 267 default grants): ALL for School Admin, Principal, Vice Principal, Admission Officer; ASSIGNED for Teacher / Class Teacher.
- `isUniqueViolationOf` (`lib/db-errors`) maps composite and partial unique-index violations by index name or exact column set.
- `db:check` verifies the classes/sections CHECKs, RESTRICT foreign keys and the partial class-teacher index once the migration is applied.

### Changed (Phase 2 Classes & Sections)
- Seed core: a permission created in a seed run also gets its catalog default grants on existing roles (otherwise `academic.read` would reach Super Admin only on an existing database). Existing grants are still never changed; audited as `newPermissionGrantsCreated`.

### Added (Phase 2a — offline, DB verification pending)
- School settings screen (`/erp/settings`): profile, regional time zone, timings, logo upload/remove, PDF letterhead preview.
- Academic sessions screen (`/erp/settings/sessions`): create, edit planned, activate, make current, close — no overlaps, audited.
- Private/public file storage layer (`lib/storage`) with magic-byte validation, random keys, encryption for private files and an authorized download route (`GET /api/v1/files/:id`).
- PDF generation (`@react-pdf/renderer` 4.9.0) with a shared branded A4 letterhead (`GET /api/v1/documents/preview`).
- "Settings" navigation item; mobile "More" menu when the bottom bar would overflow.

### Added (Phase 2a schema — prepared, not applied)
- Migration `20261109000000_phase2a_files_documents_settings` (awaiting approval): file purpose & ownership, regional settings, logo foreign key, issued-document registry with hashed verification codes.
- Ownership-bound private file access; generated-document issue/verify/revoke services.
- School Admin may manage school settings and academic sessions.
- New permission `document.revoke` (Super Admin, Principal); revoking an issued document no longer follows from `document.generate`.
- `DOCUMENT_VERIFICATION_KEY` (+ `_VERSION`, `_V<n>` for rotation) — required; documents record which key version hashed their code.
- ADR-030: one school per installation.

### Changed (Phase 2a)
- Final review fixes: canonical rotated-key names (`DOCUMENT_VERIFICATION_KEY_V<n>`, no leading zeros); shared-cache headers only for anonymously readable files; private storage root may not be inside `public/` or `.next/`; migration guard also checks `school_setting` ids; `env:check` validates rotated keys.
- Pending migration revised: transactional, pre-flight guard, legacy files owned by `LegacyFile`, all CHECKs fully validated, private ⇒ encrypted.

### Fixed (Phase 2a)
- G7 B3 (KI-050): the PDF letterhead footer ("Generated …" in the school time zone, "Page X of Y") is printed inside every A4 page again; it was drawn ~6200 pt below the page because `lineHeight` was set on `<Page>`. Body line spacing unchanged (14.7 pt).
- G7 B4 (KI-051): the document preview text reads "Settings > School profile"; the "→" glyph does not exist in the built-in PDF font and printed as "'". Templates are now tested to contain only WinAnsi characters.
- G7 B5 (KI-052): after a forced password change the ERP menu now shows the user's real permissions immediately (the layout is re-rendered); before, only Dashboard and My account appeared until a full reload.
- G7 B1 (KI-049): the settings time zone dropdown now always shows the stored zone (legacy ICU names such as `Asia/Calcutta` map to `Asia/Kolkata`); previously it pre-selected `Africa/Abidjan`. Legacy names are stored in their current spelling; unknown values are rejected.
- G7 B2 (KI-048): logos over 800 KB are rejected in the browser with the server's message before upload, instead of hitting Next.js's 1 MB server-action body limit and the generic error page.
- KI-032: ERP dates now use the school's configured time zone; date-only values no longer shift a day.
- File-store backup: the manifest (format 2) no longer contains plaintext content hashes of private files; verification still decrypts each private file and compares it with the database hash. Backup docs list every key needed for recovery, the recovery sequence, and that database and file backups are not atomic (KI-047).
- Backup drill: `date`/`timestamp` columns no longer shift in the JSON round-trip on a machine outside UTC (drill sessions use UTC/ISO and read date/time values as text; JS Dates are refused). The write check now requires the new `audit_log` id to exceed the restored maximum. G6-A checklist documents the point-in-time child branch method (schema-only branches are refused by `drill:env`).

### Added (Neon setup guide)
- docs/NEON_SETUP_GUIDE.md — verified owner procedure for Neon development/test branches, local env files, keys, `env:check` and migration review (test branch via `DOTENV_PATH` inside `try/finally`).

### Added (UI audit & roadmap)
- docs/LOCAL_UI_AUDIT.md, docs/DEVELOPMENT_ROADMAP.md (phases 0–10); styled 404 page; ERP loading skeleton; `lib/format.ts` (school time zone).
- Claude Code: devops-ci-engineer and documentation-manager agents; 10 new skills; shared agent guardrails.

### Fixed
- Tablets got 36 px controls (compact sizes now require a fine pointer).
- Dates rendered in the server's time zone.
- Stale/incorrect instructions in `.claude/` rules, agents and skills.

### Added (CI)
- GitHub Actions CI (`.github/workflows/ci.yml`): typecheck, lint, architecture check, unit tests, production dependency audit and production build on Node 26 / Ubuntu, read-only, no secrets or database.

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
