# API Documentation

Status: **conventions only** (Phase 0). Each phase adds its endpoints below; nothing is listed until it is implemented and tested.

## Conventions

- Base path: `/api/v1`. JSON only. Auth via `sid` session cookie (same-origin). Public endpoints are marked **public**.
- Server actions are used for ERP forms; they call the same services as the REST handlers. REST exists for: exports/downloads, imports, integrations, mobile clients, webhooks, chatbot.
- Request validation: Zod; invalid input → `422`.
- Pagination: `?page=1&pageSize=25` (max 100) → `{ data: [...], page, pageSize, total }`.
- Filtering: explicit query params per endpoint (no generic query language).
- Idempotency: `POST` that creates payments or imports accepts `Idempotency-Key` header.

### Error envelope

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not have permission to perform this action.", "requestId": "req_…", "details": [] } }
```

| HTTP | code |
|---|---|
| 400 | BAD_REQUEST |
| 401 | UNAUTHENTICATED |
| 403 | FORBIDDEN |
| 404 | NOT_FOUND |
| 409 | CONFLICT (duplicate, state transition not allowed) |
| 422 | VALIDATION_FAILED (`details`: `[{ path, message }]`) |
| 429 | RATE_LIMITED |
| 500 | INTERNAL (no internals in message) |

## Implemented endpoints

| Method & path | Auth | Purpose | Responses |
|---|---|---|---|
| `GET /api/health` | public | **Liveness only** — never touches the DB (so monitors don't keep Neon awake) | `200 {"status":"ok"}` |
| `GET /api/health?deep=1` | `Authorization: Bearer $CRON_SECRET` | Liveness + DB reachability | `200 {"status":"ok","database":"ok"}` · `401` · `503 {"status":"degraded","database":"unreachable"}` |
| `GET /api/v1/files/:id` | PUBLIC files: anyone. PRIVATE files: Super Admin only on this generic route. Everyone else reads PRIVATE files through the owning module's route, which applies its record-scope policy and passes the owner to `readStoredFile` (purpose + owner must match). Uploading grants no read right. | Streams a stored file. Missing **and** forbidden both return `404` (no existence oracle). `nosniff`; `Content-Disposition` inline for images/PDF, attachment otherwise; PUBLIC → `Cache-Control: public, max-age=86400, immutable` + ETag (sha256), served from a bounded 10-minute in-process cache so anonymous requests don't hit the database; PRIVATE → `private, no-store`, decrypted server-side, audited `file.download` | `200` · `404` · `503` · **S-04/S-10 (2026-11-10):** in-process per-IP limit 120/min before any lookup → `429` (`Retry-After: 60`); anonymous not-found answers cached 5 min (no database per probe; never affects signed-in users); non-public files served via `privateFileResponse` (PDF: sandboxed attachment, `no-store`) |
| `GET /api/v1/documents/preview` | session + `settings.read` | Letterhead preview PDF (school branding only, **no personal data**) | `200 application/pdf` · `401` · `403` · `503` |
| `POST /api/v1/admissions/:id/documents` | session + `student.document.manage` + `admission.read` (ALL); **same-origin** (`Origin` = Host or `APP_URL`; `Sec-Fetch-Site` same-origin); rate limit 30 / 10 min per user; ≤ 2 concurrent per instance | Upload one admission document or the photo (KI-048 route — 10 MB; never a server action). `multipart/form-data`: `type` (PHOTO, BIRTH_CERTIFICATE, TRANSFER_CERTIFICATE, PREVIOUS_MARKSHEET, OTHER), `label` (required for OTHER), `file`, optional `from` (`edit`/`detail`). `Content-Length` required and checked **before** the body is read; body read with a hard cap. Content detected from bytes (PDF/JPEG/PNG; photo JPEG/PNG → re-encoded 600×600 JPEG without metadata by `sharp`). Stored PRIVATE + encrypted, owned by the `StudentDocument` row; audited (`document.upload` / `document.replace`, `file.upload`). Only while the application is undecided | `201 {"document":{id,type}}` · `401` · `403` (CSRF/RBAC) · `404` · `409` (decided) · `413` · `415` · `422` · `429` · `503` (busy). With `Accept: text/html`: `303` to edit step 5 or the application page with `?upload=<fixed code>` (or `/login`) · **S-01 (2026-11-10):** users without `student.document.manage` + ALL-scope `admission.read` (or with a pending password change) get `403` before an upload slot is taken or the body is read; the body must arrive within 120 s → else `408` (`too_slow`) |
| `GET /api/v1/admissions/:id/documents/:docId` | session + `admission.read` (ALL) + the purpose's read permission (`student.document.read`; photo: `student.read`); owner-bound | Download one document of that application (audited `file.download`). PDFs `attachment` + `Content-Security-Policy: sandbox`; images inline; always `private, no-store`, `nosniff` | `200` · `401` · `404` (missing, other application or forbidden) · `503` |
| `GET /api/v1/students/:id/photo` | session + `student.read` (ALL, or ASSIGNED = class teacher of the student's section) + record scope; file layer owner-bound to the photo's StudentDocument; read audited (`file.download`) | The student's current photo (inline, `private, no-store`, `nosniff`) | `200 image/jpeg` · `401` · `404` (missing **and** forbidden — no existence oracle) · `503` |
| `GET /api/v1/students/:id/documents/:docId` | session + `student.read` scope + `student.document.read`; owner-bound; audited | Download one of the student's documents (PDF: attachment + `CSP: sandbox`; images inline) | `200` · `401` · `404` (missing, other student's, forbidden) · `503` |
| `POST /api/v1/students/export` | session + `export.run` + `student.read` (scope applied) + `admission.read` at ALL (so the Accountant can't export student data, D8); **same-origin** (POST so the Origin check applies — design §2.1 said GET); rate limit 10 / 10 min per user; `application/x-www-form-urlencoded` ≤ 4 KB with the directory filters `session`, `class`, `section`, `status`, `q` | CSV of the filtered directory (UTF-8 BOM, CRLF, formula-injection guard), ≤ 5,000 rows — refused above, never truncated. Audited `student.export` (filters + row count, never data) | `200 text/csv` attachment · `401` · `403` · `409` (too many rows) · `422` · `429` · `503`; failed browser form posts → `303 /erp/students?export=<fixed code>` (or `/login`) · body read through the capped reader (10 s); the audit records filters without the search text; one query refuses above 5,000 rows (export hardening, 2026-11-10) |
| `POST /api/v1/employees/export` (Phase 3A M5) | session + `export.run` + `employee.read` (ALL); **same-origin**; rate limit `export` per user; form body ≤ 4 KB, read with a 10 s deadline | CSV of the staff directory with the directory filters (`q`, `type`, `department`, `designation`, `status`, `appointment` — the last only applied for personal-tier callers). **Directory fields only** (Employee ID, Name, Staff type, Designation, Department, Status, Work phone, Work email) — never personal-tier data; ≤ 5,000 rows (refused, never truncated); spreadsheet-safe cells (S-11); audited `employee.export` with filter names and row count only | `200 text/csv` attachment `staff-YYYY-MM-DD.csv`, `private, no-store` · `401` · `403` (CSRF/RBAC) · `409` (too many) · `422` · `429` · `503`. With `Accept: text/html`: `303` to `/erp/hr/employees?export=<fixed code>` (or `/login`) |
| `POST /api/cron/cleanup` | `Authorization: Bearer $CRON_SECRET` (≥ 32 chars; endpoint disabled if unset) | Deletes expired sessions, expired rate-limit buckets, reset tokens > 7 days old, usage counters > 400 days | `200 {"status":"ok","deleted":{sessions,rateLimitBuckets,resetTokens,usageCounters}}` · `401` · `503` |

ERP screens use **server actions** (not REST) that call the same services:

| Screen | Actions (service → permission) |
|---|---|
| `/login`, `/forgot-password`, `/reset-password` | `login`, `requestPasswordReset`, `completePasswordReset` (public, rate limited) |
| `/erp/change-password`, `/erp/account` | `changeOwnPassword` (self), `revokeUserSessions(self, keepCurrent)` |
| `/erp/users`, `/erp/users/new`, `/erp/users/[id]` | `listUsers`/`getUser` → `user.read`; `createUser`, `updateUser`, `setUserActive`, `adminResetPassword`, `unlockUser`, `revokeUserSessions` → `user.manage` + policy |
| `/erp/settings` | `getSchoolSettings` → `settings.read`; `updateSchoolProfile`, `setSchoolLogo`, `removeSchoolLogo` → `settings.manage` (all audited) |
| `/erp/settings/sessions` | `listAcademicSessions` → `settings.read`; `createAcademicSession`, `updateAcademicSession` (PLANNED only), `changeAcademicSessionStatus`, `setCurrentAcademicSession` → `session.manage` (advisory-locked, audited) |
| `/erp/roles`, `/erp/roles/new`, `/erp/roles/[id]` | `listRoles`, `getRole`, `createRole`, `updateRole`, `setRolePermissions`, `deleteRole` → `role.manage` + policy |
| `/erp/admissions`, `/erp/admissions/new`, `/erp/admissions/[id]`, `/erp/admissions/[id]/edit?step=1–6` | `listApplications`, `countApplicationsByStatus`, `getApplication`, `applicationFilterOptions` → `admission.read`; `createDraft`, `updateStudentStep`, `updateGuardiansStep`, `updateContactStep`, `updatePreviousSchoolStep`, `deleteDraft`, `submitApplication`, `admissionFormOptions` → `admission.create`; `startReview`, `setSection`, `returnToDraft`, `rejectApplication`, `sectionChoices`, `guardianMatches`, **`approveApplication`** (= registration: student, permanent IDs, guardians, enrollment — one transaction, lock_timeout 5 s) → `admission.approve`; `removeApplicationDocument`, `verifyApplicationDocument` → `student.document.manage`; `listApplicationDocuments` → `student.document.read` (all audited; application row locked + versioned) |
| `/erp/students`, `/erp/students/[id]`, `/erp/students/[id]/edit`, `/erp/students/[id]/status` | `listStudents`, `countStudentsByStatus`, `studentFilterOptions`, `getStudent` → `student.read` (ALL; ASSIGNED = ACTIVE enrollment in a section where the user is class teacher; SELF/CHILDREN refused until the portal) — documents only with `student.document.read`, application link only with `admission.read` ALL; `updateStudent` → `student.update` (ALL: names, DOB, gender, contact, address; ASSIGNED: phone, email, address only; student ID / admission no. never — not in the schema); `updateGuardian` → `student.update` (ASSIGNED: phone / alt phone / email only; shared by siblings); `changeStudentStatus` → `student.transfer` (ACTIVE → TRANSFERRED/WITHDRAWN/GRADUATED; ACTIVE enrollments in non-closed sessions → LEFT; roll number kept; append-only StudentStatusChange). Lock order student → session → section; lock_timeout 5 s; optimistic `version`; audited (`student.update` with changed fields before/after, `guardian.update`, `student.status_change` without the reason text) |
| `/erp/students/registration`, `/erp/students/registration/[sectionId]` | `listSectionsForRollNumbers`, `getRollNumberSheet` (preview, no writes) → any of `rollnumber.generate` / `rollnumber.finalize` / `rollnumber.correct`; `generateRollNumbers` (DRAFT) → `rollnumber.generate`; `finalizeRollNumbers` (type the section code; draft must still match) → `rollnumber.finalize`; `correctRollNumber` (free number + reason) → `rollnumber.correct`. `appendRollNumberOnEnrollment` runs inside `approveApplication` for FINALIZED sections (max + 1, never reused). Lock order session → section → batch; lock_timeout 5 s; audited (`rollnumber.generate` / `.finalize` / `.append` / `.correct`) |
| `/erp/hr/employees`, `/erp/hr/employees/new`, `/erp/hr/employees/[id]`, `/erp/hr/employees/[id]/edit` (Phase 3A M2) | `listEmployees`, `countEmployeesByStatus`, `getEmployee` → `employee.read` (lists ALL; `getEmployee` also SELF = own linked record, M3b) with the **personal tier** (dob, gender, personal phone/email, address, emergency contact, employment dates) only for `employee.personal.read` (ALL) — directory readers get directory fields only and can't search by personal phone; `registerEmployee` (permanent `EMP-{YYYY}-{SEQ:4}` from `lib/sequence`, joining year; staff type from the designation; JOINED service event; one transaction), `updateEmployeePersonal`, `updateEmployeeContact` (optimistic `version`) → `employee.manage` **and** `employee.personal.read`; `listReportingCandidates` → `employee.manage`. Audit rows carry ids/codes/enums and field names; personal values and employment terms (appointment type, joining/confirmation/leaving dates) `[REDACTED]`; directory readers can't filter by appointment type. By design (H3) the employee ID shows the joining year to every directory reader |
| `/erp/hr/departments`, `/erp/hr/designations` (Phase 3A M2) | `listDepartments`, `listDesignations` → `employee.read`; `createDepartment`, `updateDepartment`, `setDepartmentActive`, `createDesignation`, `updateDesignation`, `setDesignationActive` → `employee.manage` (row-locked, versioned, audited; never deleted; code and a designation's staff type fixed once staff use them; names any script, unique by NFKC + Unicode lower-case key) |
| `/erp/hr/employees/[id]` — teacher profile and login account (Phase 3A M3a) | `getTeacherProfile` → `employee.read` (ALL; professional data, not personal tier); `saveTeacherProfile` (create with `version` null, then optimistic version; TEACHING employees only, checked under the employee row lock; audit records changed field names only) → `employee.manage`. `staffAccountPanel` → `user.read` (linked username/status; link picker = active unlinked accounts for linkers); `linkStaffAccount`, `unlinkStaffAccount` → **`employee.manage` + `user.manage`** (H2; by default Super Admin only — HR Manager has no `user.manage`, Q2), employee FOR UPDATE → user FOR UPDATE, `assertCanModifyUser` delegation check, one account per employee and one employee per account, audited by identity (`user.employee_link` / `user.employee_unlink`). Since M3b the link carries SELF access: linkers also need `employee.read` + `employee.personal.read` at ALL, and non–Super Admins can't link their own account (KI-065) |
| `/erp/hr/employees/[id]/edit` (employment, reporting) and `/erp/hr/employees/[id]/status` (Phase 3A M4a) | `changeEmployment` (department, designation of the same staff type, appointment type, confirmation date — one service event per change), `changeReporting` (serialized by an advisory lock; loops, self-reporting and leavers as managers refused), `changeStatus` (resign / terminate / retire / long-term leave / back from leave / rejoin; leaving releases the linked account's class-teacher sections and optionally deactivates the account — `user.manage`, `lockSuperAdminGuard` first, same rules as deactivating a user; without it the result says the login is still active) → `employee.manage` + `employee.personal.read` (ALL) + directory; never on the caller's own record (Super Admin exempt). `listServiceHistory` → record access (ALL or own SELF) **and** personal tier — directory readers get none. Append-only: no update/delete function exists |
| `/erp/hr` (Phase 3A M5 — staff overview) | `hrDashboard` → `employee.read` (ALL): counts by staff type × status and by department for every directory reader; recent joiners/leavers only for the personal tier; current staff without a linked login account only with `user.read` (relation filter in the database); active teaching staff without a class-teacher section in the current session only with `user.read` + `academic.read` ALL (`academic.classTeachersOfCurrentSession`) |

## Planned endpoint groups

Phase numbers follow docs/DEVELOPMENT_ROADMAP.md. Phase 1 auth/users/roles shipped as **server actions** (see above), not REST; REST versions will be added only if a client needs them.

| Group | Base | Roadmap phase |
|---|---|---|
| Auth (REST, optional) | `/api/v1/auth/{login,logout,password-reset}` | 1 — done as server actions |
| Users & roles (REST, optional) | `/api/v1/users`, `/api/v1/roles` | 1 — done as server actions |
| Files | `/api/v1/files/:id` (authorized download) | 2 |
| CMS public | `/api/v1/public/*` **public** | 8 |
| Enquiries | `POST /api/v1/public/enquiries` **public**, rate-limited | 8 |
| Students & admissions | `/api/v1/students`, `/api/v1/admissions` | 2 |
| Roll numbers | `/api/v1/sections/:id/roll-numbers/{preview,generate,finalize,correct}` | 2 |
| Documents | `/api/v1/documents/{id-cards,certificates}`, `GET /verify/:code` **public** | 2 (ID cards) · 7 (certificates) |
| HR | `/api/v1/employees`, `/api/v1/leave-requests` | 3 |
| Attendance | `/api/v1/attendance/{students,employees}` | 3 (staff) · 4 (students) |
| Payroll | `/api/v1/payroll-runs`, `/api/v1/payroll-runs/:id/{prepare,approve,pay}` | 3 |
| Fees | `/api/v1/fee-structures`, `/api/v1/invoices`, `/api/v1/payments`, `/api/v1/payments/online/order` | 5 |
| Webhooks | `POST /api/webhooks/payments/razorpay` (signature-verified) | 5 |
| Transport | `/api/v1/transport/{vehicles,routes,assignments}` | 7 |
| Exams | `/api/v1/exams`, `/api/v1/exams/:id/marks`, `/api/v1/report-cards` | 4 |
| Library/Inventory | `/api/v1/library/*`, `/api/v1/inventory/*` | 7 |
| Import/Export | `/api/v1/imports`, `/api/v1/exports/:report` | 2–7 (incremental) |
| Chatbot | `POST /api/v1/chat` **public**, `/api/v1/chatbot/knowledge` | 9 |
| Notifications | `/api/v1/notifications` | 6 (portal) · 10 (complete) |
