# Phase 2b — Student Admission & Student Management: design and implementation plan

Status: **DESIGN APPROVED (D1–D12, 2026-11-10). S0 ✓, S1 ✓ (migration applied to development, drift 0), S2 ✓ (catalog 82/13/271), S3 ✓ offline, S4 ✓ (sharp standalone verified on Windows, KI-056), S5 ✓ offline (approval = registration, D11 settings), S6 ✓ offline (roll numbers; `next build` ✓ 2026-11-10), S7 ✓ offline (student directory, profile, field-level edits, status changes, CSV export). Integration pending the Test branch. S8 next — needs the Test-branch approval.**
Migration `20261111000000_phase2b_admissions_students` is prepared offline and **unapplied**. Services, UI,
catalog/seed changes and tests below are proposals awaiting owner approval (decisions §1).
ADR: [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) ADR-035 (accepted 2026-11-10).

> **Naming.** The owner's brief calls this "Phase 3". In [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) admissions,
> students, IDs and roll numbers are the remainder of **Phase 2 (Student Information System)**; roadmap Phase 3 is
> Staff & HR. This document uses **Phase 2b** so the roadmap's numbering (and its references in skills, docs and
> tests) stays valid. Rename on request.

## 0. What already exists (reused, not duplicated)

| Area | Existing | Used for |
|---|---|---|
| Sessions, classes, sections | `settings.service` (sessions), `modules/academic` (classes, sections, capacity, class teacher, `FOR SHARE` session lock) | Session/class/section selection, capacity, ASSIGNED scope |
| Sequences | `lib/sequence` (`nextSequence` row-locked upsert, `formatSequence`, `sequenceKey`) + `SchoolSetting.idFormats` (`studentId`, `admissionNo`) | Application no., admission no., student ID |
| Private files | `files.service` two-phase upload (`prepareUpload` → `recordUpload(tx)` → `discardUpload`), magic-byte detection, AES-256-GCM, owner-bound `canReadStoredFile` | Documents and photos |
| Permissions | `admission.read/create/approve`, `student.read/create/update/delete/document.read/promote/transfer`, `rollnumber.generate/finalize/correct` already in the catalog | Most of the RBAC (§4) |
| UI kit | `TextField`, `SelectField`, `FormStatus`, `SubmitButton`, `ConfirmAction`, `PageHeader`, table ≥ md / cards < md pattern | Every screen |
| Domain rules | skills `student-admission`, `student-id-generation`, `roll-number-generation`, `student-information` | Workflow, ID, roll-number rules (adapted where the brief differs, §2) |

Not reusable as is: the generic `GET /api/v1/files/:id` serves PRIVATE files to Super Admin only (no owner scope) — documents
get module routes (§5.3). Server actions can't take 10 MB uploads (KI-048) — a dedicated upload route is built first (§5.2).

## 1. Owner decisions needed

> **All decisions D1–D12 APPROVED by the owner on 2026-11-10** (naming "Phase 2B"; Phase 3 stays Staff & HR).
> The table below keeps the original proposals; the **approved wording, including mandatory safeguards, is §1a** and
> takes precedence.

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Approve = register** in one transaction (approval creates Student, IDs, guardians, enrollment) vs. a separate "register" step after approval | **One transaction** — no "approved but not registered" limbo; the "Registration" screen is the per-section roll-number screen (§6) |
| D2 | Who approves | **School Admin + Principal** (`admission.approve`; Principal gains it). Admission Officer prepares and submits only (maker-checker) |
| D3 | Roll numbers | Per section: **preview → generate (draft) → finalize**, alphabetical (§2.4). After finalization, later admissions are **appended** (max + 1); finalized numbers never change automatically. Generate: School Admin / Admission Officer (`rollnumber.generate`); finalize: Principal / Vice Principal (`rollnumber.finalize`, existing) |
| D4 | ID year token `{YYYY}` | **Start year of the admission's academic session** (2026-27 → 2026), not the calendar year of approval |
| D5 | Application number | `APP-{SESSION}-{SEQ:4}` (e.g. `APP-2026-27-0001`), assigned on **first submit** (drafts get none → no gaps). New `idFormats.applicationNo` key with that default |
| D6 | Aadhaar and medical data | **Not collected in Phase 2b** (data minimisation, DPDP). Added later only with `student.sensitive.read`, encryption + HMAC as already designed |
| D7 | Photo processing | (a) add `sharp` (server re-encode, strips EXIF/GPS — what SECURITY.md promises; native dependency with an install script → `allowScripts` review) **or** (b) dependency-free: browser crops/resizes to 600×600 JPEG + server strips JPEG APPn/COM and PNG ancillary chunks and checks dimensions. **Recommend (a)** if the install-script review is acceptable; (b) otherwise |
| D8 | Accountant | Keeps existing `student.read` (ALL — needed for fee lookup) but gets **no** admissions, documents or export of student data; no new grants. Revisit field-level limits in Phase 5 |
| D9 | Siblings | Same guardian phone → the reviewer is **shown** matching guardians and explicitly links or creates new. Never auto-merged |
| D10 | Required documents | Configurable list (default: photo + birth certificate). Missing ones → "documents pending" badge; **approval allowed** with a warning (school practice varies) |
| D11 | KI-044 | Approve app-wide `transactionOptions` (e.g. `maxWait` 10 s, `timeout` 15 s) before the 50-concurrent-admissions test (§9). Currently pinned unchanged by a guard test as an owner decision |
| D12 | Attendance / fee summary on the profile | **Not shown** until those modules exist (project rule: no placeholders). The profile reserves no fake tabs |

### 1a. Approved decisions (owner, 2026-11-10) — binding

| # | Approved decision |
|---|---|
| D1 | Admission approval and student registration happen in **one database transaction**. |
| D2 | Approvers: **School Admin and Principal** (`admission.approve`; Principal gains it). The Admission Officer prepares and submits applications. |
| D3 | Roll numbers: **preview → draft → finalize** per section. School Admin and Admission Officer generate drafts (`rollnumber.generate`); Principal and Vice Principal finalize (`rollnumber.finalize`). **Finalized roll numbers never change automatically** (later admissions append; corrections only via `rollnumber.correct` with a reason). |
| D4 | `{YYYY}` in student IDs / admission numbers = **start year of the academic session**. |
| D5 | Application number **`APP-{SESSION}-{SEQ:4}`** (e.g. `APP-2026-27-0001`), assigned on **first submission**. |
| D6 | **No Aadhaar and no medical data** in Phase 2B. |
| D7 | **`sharp` 0.35.5 as a pinned direct dependency** for server-side photo processing, **subject to verifying standalone-build compatibility**. No unapproved install-script exceptions (`allowScripts` unchanged). |
| D8 | Accountant **keeps its existing `student.read`**; no admission, document or export permissions. Field-level restrictions reviewed in Phase 5. |
| D9 | **Explicit manual guardian linking** when a phone number matches; never automatic merging or linking of families. |
| D10 | Required documents **configurable**, default **student photo + birth certificate**; missing documents show a **warning but do not block approval**. |
| D11 | App-wide transaction **`maxWait` 10 000 ms, `timeout` 15 000 ms**, with mandatory safeguards: (1) no file I/O, image processing, password hashing or PDF generation inside transactions; (2) transactions kept short; (3) an appropriate per-approval lock timeout; (4) a friendly "busy" message; (5) verify that the hosting request timeout supports the transaction duration; (6) tests for realistic concurrency and overload; (7) **never claim that all 50 simultaneous requests succeed under the default 5-connection pool**. |
| D12 | Attendance and fee summaries **hidden** until their modules are implemented. |

Delivery: slices S0–S8 (§9), each reported with test results; every database write (migration, seed) needs its own explicit approval.

## 2. Architecture

### 2.1 Modules (modular monolith, existing layer rules)

```
src/modules/admissions/
  admissions.schemas.ts     Zod .strict(): per-step draft schemas, submit schema, review/approve/reject
  admissions.rules.ts       pure: state machine, name/phone normalisation, duplicate matching, required docs
  admissions.policy.ts      pure: which applications a scope may see/edit
  admissions.service.ts     draft CRUD, submit, startReview, setSection, reject, approve (→ students service)
  documents.service.ts      add/replace/remove/verify application & student documents (uses files.service)
src/modules/students/
  students.schemas.ts / students.rules.ts / students.policy.ts
  students.service.ts       list/search/get/update (field-level), status changes, export rows
  registration.service.ts   registerApprovedApplication(tx, …) — called ONLY by admissions.approve
  roll-number.ts            pure ordering (collator, tie-breakers) — per the roll-number skill
  roll-numbers.service.ts   preview / generate / finalize / append / correct
src/app/api/v1/admissions/[id]/documents/route.ts         POST upload (KI-048), GET list
src/app/api/v1/admissions/[id]/documents/[docId]/route.ts GET download (scoped)
src/app/api/v1/students/[id]/documents/[docId]/route.ts   GET download (scoped)
src/app/api/v1/students/[id]/photo/route.ts               GET photo (student.read scope)
src/app/api/v1/students/export/route.ts                   POST CSV (export.run + student.read + admission.read ALL; POST so the same-origin check applies — S7)
src/app/erp/admissions/**, src/app/erp/students/**        pages + server actions (≤ 30 lines each)
```
Dependencies: `admissions` → `students` (registration), `academic` (section/capacity checks), `files`, `settings`
(id formats, timezone). `students` → `academic`, `files`, `settings` (school time zone for leaving dates, S7). Name/phone helpers and person
field schemas live in `students/person-fields.ts` + `students/person.schemas.ts` (S7; re-exported by admissions). No cycles (`check:deps`).

### 2.2 Application state machine

```
DRAFT ──submit──▶ SUBMITTED ──startReview──▶ UNDER_REVIEW ──approve──▶ APPROVED (Student created)
  │                   │                           │
  └─delete (hard)     ├──────────reject───────────┴──reject──▶ REJECTED (reason)
                      └──return to draft (edits needed, reason)──▶ DRAFT
```
- Edits: DRAFT freely (`admission.create`); SUBMITTED/UNDER_REVIEW only via "return to draft" (keeps the application no.).
- APPROVED and REJECTED are final (a rejected child re-applies with a new application).
- Every transition: `SELECT … FOR UPDATE` on the application + optimistic `version`; audited.

### 2.3 Approval = registration transaction (D1)

One `prisma.$transaction`, short (no PDF/Argon2/file I/O inside):
1. `authorize(ctx, "admission.approve")`; lock application `FOR UPDATE`; status ∈ {SUBMITTED, UNDER_REVIEW}; version matches.
2. Session `FOR SHARE` (not CLOSED); section `FOR UPDATE`: active, same class and session as the application,
   **ACTIVE enrollments < capacity** (`activeEnrollmentCount` becomes a real count here).
3. Re-run duplicate detection (§2.5) inside the transaction; matches without `duplicateOverride` → `ConflictError`.
4. `nextSequence` for admission no. and student ID (keys per `sequenceKey`, D4) → `formatSequence`.
5. Create Student, Guardians (new or reviewer-linked, D9), StudentGuardian, StudentEnrollment (ACTIVE,
   `enrolledOn = admissionDate`); set `studentId` on the application's documents; application → APPROVED.
6. If the section's roll-number batch is FINALIZED → append (`max + 1`, source APPENDED) under the batch's row lock;
   otherwise no roll number yet (assigned at generation).
7. Audit (`admission.approve`, `student.create`, `guardian.create`/`guardian.link`, `enrollment.create`, `rollnumber.append`).
Guards against double registration: application row lock + `admission_application.student_id` UNIQUE +
`student_enrollment (student_id, academic_session_id)` UNIQUE + CHECK `APPROVED ⇔ student_id`.

### 2.4 Roll numbers (D3; skill `roll-number-generation`)
- Ordering in the application (not SQL collation): `Intl.Collator("en-IN", { sensitivity: "base", numeric: true, ignorePunctuation: true })`
  over the NFC-normalised full name → tie-break 1 **date of birth (older first)** → tie-break 2 **student ID** (unique,
  so the order is total and deterministic).
- Preview (no writes) → Generate (DRAFT, replaceable) → Finalize (type-to-confirm; verifies the draft still matches the
  section's ACTIVE enrollments, else "generate again"). Finalized: late admissions appended; leavers keep their number;
  numbers never reused in that session; corrections only via `rollnumber.correct` with a reason (audited per row).

### 2.5 Duplicate detection
Normalised name (NFC, trim, collapse spaces, lower case) + DOB against (a) students not deleted and (b) open applications
(SUBMITTED/UNDER_REVIEW) in any session; plus any guardian phone in common → stronger match. Shown as warnings at
submit and on the review screen (ids/codes the reviewer may read only). Approving a matched application requires
`duplicateOverride` text (audited). Database backstops: unique student/application ids above.

### 2.6 Historical records
Student is session-independent; one StudentEnrollment per session (never overwritten — promotion in Phase 4 creates the
next session's row); StudentStatusChange is append-only; field edits are audited (profile timeline reads AuditLog).

## 3. Schema proposal and migration draft

`prisma/schema.prisma` (Phase 2b block) + `prisma/migrations/20261111000000_phase2b_admissions_students/migration.sql` —
**DRAFT, not applied**, generated offline (`migrate diff --from-schema --to-schema`), one transaction, expand-only,
pinned by `tests/unit/migration-phase2b-students.test.ts` (7 tests).

| Table | Purpose | Key constraints |
|---|---|---|
| `admission_application` | Applicant data until decision | U(application_no), U(student_id); CHECKs: non-DRAFT ⇒ number; APPROVED ⇔ student_id, + section/decided_at/admission_date; REJECTED ⇒ reason; dob ≥ 1990-01-01; 10-digit phone; version ≥ 1 |
| `admission_guardian` | Guardians as entered | partial U(application, relation) WHERE FATHER/MOTHER; partial U(application) WHERE is_primary; CASCADE with the (draft) application |
| `student` | Permanent record | U(student_code), U(admission_no); IX(full_name_normalized, dob), IX(status); soft delete |
| `guardian` | Shared person (siblings) | IX(phone); soft delete |
| `student_guardian` | Links + relation | PK(student, guardian); partial U(student) WHERE is_primary |
| `student_document` | Application → student documents; owns its StoredFile | U(file_id); partial U one current PHOTO per application / per student; CHECK owner set; OTHER needs label |
| `student_enrollment` | One per student per session | U(student, session); **composite FK (section_id, academic_session_id) → section(id, academic_session_id)** so a section of another session is impossible |
| `roll_number_batch` | Per section | U(section_id); FINALIZED ⇒ finalized_at |
| `student_roll_number` | Number per enrollment | U(batch, roll_number), U(enrollment); roll_number ≥ 1 |
| `student_status_change` | Append-only history | from ≠ to, reason required |

Existing tables: only **one new unique index on `section` (id, academic_session_id)** (0 rows on development). 8 enum
types, 22 CHECKs, 26 FKs, 28 indexes (records RESTRICT; actor columns SET NULL; CASCADE only guardian rows of an application and
numbers of a batch). No Aadhaar/medical columns (D6). Rollback SQL in the migration header.

## 4. RBAC

### 4.1 Permission changes (proposed)
| Change | Why |
|---|---|
| **New `student.document.manage`** — "Upload, replace, verify and remove student and admission documents" | Upload purpose needs its own permission; `student.document.read` stays read-only |
| `admission.approve` → **+ PRINCIPAL** (D2) | Maker-checker with the Admission Officer |
| No other new keys | `admission.*`, `student.*`, `rollnumber.*`, `export.run` already exist |
Totals after: **82 permissions, 13 roles, 271 grants** (from 81 / 267: +1 permission; +4 grants — SUPER_ADMIN, SCHOOL_ADMIN and ADMISSION_OFFICER for `student.document.manage`, PRINCIPAL for `admission.approve`). Seed: the new-permission rule (Phase 2) grants `student.document.manage` on existing roles; `admission.approve` for PRINCIPAL is an **existing** permission, so the seed does **not** add it to an existing database → granted through Roles UI by the Super Admin (audited) or an explicit owner-approved seed option.

### 4.2 Matrix for the roles in the brief
| Capability | Super Admin | School Admin | Principal | Admission Officer | Class Teacher | Teacher | Accountant |
|---|---|---|---|---|---|---|---|
| View applications (`admission.read`) | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Create/edit drafts, submit (`admission.create`) | ✓ | ✓ | — | ✓ | — | — | — |
| Review, approve, reject (`admission.approve`) | ✓ | ✓ | **✓ (new)** | — | — | — | — |
| Upload/verify documents (`student.document.manage`) | ✓ | **✓** | — | **✓** | — | — | — |
| Read documents (`student.document.read`) | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Student directory/profile (`student.read`) | ALL | ALL | ALL | ALL | ASSIGNED | ASSIGNED | ALL (D8) |
| Photo (follows `student.read`) | ALL | ALL | ALL | ALL | ASSIGNED | ASSIGNED | ALL (D8 — owner may restrict) |
| Edit student (`student.update`) | ✓ | ✓ | — | ✓ | ASSIGNED, contact fields only | — | — |
| Status change (`student.transfer`) | ✓ | ✓ | — | — | — | — | — |
| Roll numbers generate / finalize / correct | ✓/✓/✓ | ✓/—/— | —/✓/✓ | ✓/—/— | — | — | — |
| Export student list (`export.run` + `student.read`) | ✓ | ✓ | — | — | — | — | ✗ (holds `export.run` for fee/payroll only — student export additionally requires `admission.read`, D8) |
| Fees / payroll | as today — **no new finance or payroll grant to anyone** | | | | | | |

ASSIGNED for `student.read` (until TeacherAllocation, Phase 4) = students with an **ACTIVE enrollment in a section where
the user is class teacher**. Teachers never see applications, documents or other sections. Field-level: Class Teacher
`student.update` limited to phone/email/address and guardian contact numbers (service rule, unit-tested).

### 4.3 Audit events (same transaction as the change; sensitive values never stored)
`admission.create`, `admission.update` (changed fields), `admission.submit`, `admission.return_to_draft`,
`admission.review_start`, `admission.section_set`, `admission.approve` (+ duplicateOverride flag), `admission.reject`,
`admission.delete_draft`, `document.upload`, `document.replace`, `document.remove`, `document.verify`, `document.read`
(private download), `student.create`, `student.update`, `student.status_change`, `guardian.create`, `guardian.link`,
`enrollment.create`, `rollnumber.generate`, `rollnumber.finalize`, `rollnumber.append`, `rollnumber.correct`,
`student.export` (filters + row count, never the data). Names/phones/addresses are not copied into audit
`after` for reads; updates record changed field names with old/new values (no sensitive fields exist in 2b).

## 5. Service and API design

### 5.1 Services (all `authorize` → policy → transaction → audit; Zod `.strict()`; explicit `select`)
| Function | Permission | Notes |
|---|---|---|
| `createDraft`, `updateDraftStep(step)`, `deleteDraft` | admission.create | step schemas: student, guardians, contact/address, previous school/class, review |
| `submitApplication` | admission.create | full-schema validation; number assigned (D5); duplicate warnings stored |
| `returnToDraft`, `startReview`, `setSection` | admission.approve | section must match class/session, active, capacity preview |
| `approveApplication` | admission.approve | §2.3 |
| `rejectApplication` | admission.approve | reason required |
| `listApplications`, `getApplication` | admission.read | filters: session, class, status, search (name / application no.), page ≤ 100 |
| `addDocument`, `replaceDocument`, `removeDocument`, `verifyDocument` | student.document.manage | via `files.service`; application must be undecided, or the student not deleted |
| `listStudents`, `getStudent` | student.read (+ policy) | search name / student ID / admission no.; filters session, class, section, status; page ≤ 100 |
| `updateStudent` | student.update | IDs immutable (ValidationError); field-level for ASSIGNED |
| `changeStudentStatus` | student.transfer | enrollment → LEFT with date; StudentStatusChange row |
| `previewRollNumbers`, `generateRollNumbers`, `finalizeRollNumbers`, `correctRollNumber` | rollnumber.* | §2.4 |
| `exportStudentRows` | export.run + student.read + admission.read | CSV, CSV-injection-safe (`=`,`+`,`-`,`@`,tab,CR prefixed with `'`), ≤ 5 000 rows, rate-limited, audited |

### 5.2 Upload route — resolves KI-048 (built **before** any document UI)
`POST /api/v1/admissions/:id/documents` (multipart: `type`, `label?`, `file`); later `POST /api/v1/students/:id/documents`.
1. **CSRF:** cookie-authenticated mutation outside server actions → require `Origin` equal to `APP_URL`'s origin and
   `Sec-Fetch-Site: same-origin` (when sent); else 403.
2. Session via `getAuthContext`; pending password change → 403. `enforce(RULES.upload, userId)` (new rule, e.g. 30 / 10 min).
3. **Size before parsing:** `Content-Length` required and ≤ 10 MB + 64 KB envelope → else 413 *without reading*; then read
   the body stream with a hard byte cap (aborts if the header lied), parse multipart from the capped buffer.
4. Zod-validate fields; service `addDocument` → `prepareUpload(purpose)` (magic bytes, allowlist, encryption) →
   transaction (`recordUpload` + StudentDocument + retire replaced photo + audit) → `discardUpload` on failure.
5. Purposes (new in `UPLOAD_RULES`): `student.document` — PDF/JPEG/PNG ≤ 10 MB, PRIVATE, upload `student.document.manage`,
   read `student.document.read`; `student.photo` — JPEG/PNG ≤ 2 MB (D7 processing), PRIVATE, read `student.read`.
   Owner = (`StudentDocument`, document id).
6. Responses: 201 JSON; errors 400/403/404/409/413/415/422/429 as `{ error: { code, message } }`. With
   `Accept: text/html` (plain form post, no JavaScript) → 303 back to the page with a status message.
Server-action body limit stays 1 MB (never raised globally).

### 5.3 Downloads
Module routes authorize the student/application first, then call `readStoredFile(ctx, fileId, { purpose, owner: { type: "StudentDocument", id } })`:
`GET /api/v1/admissions/:id/documents/:docId`, `GET /api/v1/students/:id/documents/:docId`, `GET /api/v1/students/:id/photo`.
Headers: `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` on PDFs,
`Content-Disposition` attachment for PDFs, inline for images. Missing and forbidden → 404 (no existence oracle).

## 6. Frontend page plan (existing design system; 360 px first; table ≥ md, cards < md; 44 px targets)

| Route | Content | Permission |
|---|---|---|
| `/erp/students` | Student dashboard: counts by status (current session), applications awaiting review, sections without finalized roll numbers; then the **directory**: search (name, student ID, admission no.), filters (session, class, section, status), paginated table/cards, "Export CSV" | student.read |
| `/erp/students/[id]` | Profile: header (photo, name, student ID, admission no., class-section, roll no., status); tabs Overview · Guardians · Academic history (enrollments per session) · Documents · Admission · Status history. Edit (field-level) and status change for permitted roles | student.read (+ scope) |
| `/erp/admissions` | Application list: status chips, filters (session, class, status), search, "New admission" | admission.read |
| `/erp/admissions/new` → `/erp/admissions/[id]/edit/[step]` | 6 steps — 1 Student · 2 Parents/guardians · 3 Contact & address · 4 Previous school & class applied · 5 Photo & documents · 6 Review & submit. Each step saves the draft (server action, works without JS), sticky Back/Save/Next bar, progress indicator, camera capture on phones | admission.create |
| `/erp/admissions/[id]` | Review: summary, duplicate warnings, sibling guardian matches (link/create), section picker with free seats, documents (view/verify), actions Start review · Return to draft · Approve (confirm; override reason when duplicates) · Reject (reason) | admission.read / approve |
| `/erp/students/registration` → `/[sectionId]` | Registration & roll numbers per session/section: enrolled students, batch status; Preview → Generate → Finalize (type-to-confirm); appended students listed | rollnumber.* |
Navigation: "Admissions" (admission.read), "Students" (student.read). Mobile bottom bar overflows into "More".

## 7. Test plan
- **Unit (offline):** schemas (every step, `.strict()`, phone/name normalisation, dates); state machine (every transition
  allowed/refused); duplicate matching; roll-number ordering (case, accents, extra spaces, identical names → DOB → ID;
  skill example); ID formatting/keys (D4, D5); CSV escaping; field-level update rules; policies (ALL / ASSIGNED / none);
  upload route pure parts (origin check, content-length, capped reader, multipart limits); catalog counts 82/13/271 + RBAC
  matrix; migration static guard (done, 7 tests).
- **Upload security (unit + route tests with the memory driver):** wrong magic bytes, polyglot, oversize with honest and
  lying `Content-Length`, missing `Origin`, cross-site `Origin`, no session, pending password change, wrong role, other
  application's id, rate limit, PRIVATE never under `public/`, file encrypted at rest, photo metadata stripped (D7).
- **Integration (Neon test branch, separate approval):** draft → submit → review → approve creates exactly one student,
  enrollment, guardians and both IDs; reject; double approval (concurrent) → one student; **50 concurrent approvals → 50
  distinct consecutive IDs, capacity respected exactly, no deadlock/timeout (needs D11)**; duplicate student detection and
  override; capacity full → clear error; closed session / inactive section refused; composite FK refuses a foreign-session
  section; roll numbers generate/finalize/append/correct; IDs unchanged by edits; RBAC 403 for Teacher, Accountant, Parent
  on every admission/document endpoint; teacher sees only own section's students; audit rows in the same transaction.
- **E2E (Playwright, desktop/Pixel 7/iPhone 14, axe):** full admission on a phone (6 steps, photo, document), review and
  approve, roll-number finalize, directory search and profile, export download; Teacher sees only own students.

## 8. Risks, dependencies and blockers

| # | Item | Status / mitigation |
|---|---|---|
| B1 | **KI-048** — no 10 MB upload path | Blocker for documents; resolved by §5.2, built first (slice S4) |
| B2 | **KI-044** — default transaction `maxWait` 2 s, pool 5 | Blocker for the 50-concurrent test (KI-010); owner decision D11 |
| B3 | **KI-010** — 50 concurrent admissions + duplicate tests | Written in S5; run on the test branch (B4) |
| B4 | **Test branch** is not migrated with `20261110000000`; academic integration suite not run (KI-053) | Separate approval; needed before any Phase 2b integration run |
| B5 | `academic.read` seed sync not run on development | Only Super Admin sees Classes; School Admin/Admission Officer need it to pick sections — seed sync approval before S3 UI testing |
| R1 | Photo EXIF/GPS of minors | D7; until decided, no photo upload ships |
| R2 | Composite FK adds a unique index to the existing `section` table | 0 rows on development; brief SHARE lock; in the static test |
| R3 | CHECK `dob ≥ 1990-01-01` | Adjust if adult/alumni records are ever imported |
| R4 | Accountant `student.read` ALL (existing) | D8; no documents/export; revisit in Phase 5 |
| R5 | `db:check` reports the 10 new tables missing on development until the migration is applied | Expected (same as Phase 2 R3); `scripts/db-tables.ts` already lists them |
| R6 | Roadmap status: Phase 1 still "Blocked" in the roadmap table although G1–G7 passed | Documentation update (owner sign-off) — not a code blocker |
| R7 | Student import (XLSX/CSV) is in roadmap Phase 2 | Deferred to a later slice with the shared import pipeline (needs `exceljs`/`papaparse` — dependency review) |
| R8 | ID cards, QR verify page | Roadmap Phase 2; after 2b core (reuses GeneratedDocument + letterhead) |

## 9. Implementation roadmap (vertical slices; each ends with lint/typecheck/check:deps/tests green + docs)

| Slice | Content | Gate |
|---|---|---|
| S0 | Owner decisions D1–D12; KI-044 (D11); `academic.read` seed sync on development; test branch: `20261110000000` + academic integration | Owner approvals |
| S1 | Review + apply `20261111000000` to development (same procedure as Phase 2: pre-check, restore point, deploy, drift 0, db:check) | Owner approval (DB write) |
| S2 | Catalog (`student.document.manage`, Principal `admission.approve`), seed rule, RBAC matrix, count tests | Seed sync approval |
| S3 | Admissions core: schemas, rules, policy, draft/submit/review/reject services, list + 6-step form (without documents) + review screen; unit tests | — |
| S4 | **Upload route (KI-048)** + documents + photo (D7) + scoped downloads; upload security tests | — |
| S5 | Approval/registration transaction, IDs, guardians/siblings, enrollment, capacity; integration + **concurrency tests (KI-010)** | Test-branch approval |
| S6 | Roll numbers: pure ordering, preview/generate/finalize/append/correct + registration screens | — |
| S7 | Student directory, profile, field-level edit, status changes, CSV export | — |
| S8 | Full integration on test, E2E × 3 devices + axe, browser review (development), security-auditor review, docs; KI-010/KI-048 closed | Owner sign-off |
