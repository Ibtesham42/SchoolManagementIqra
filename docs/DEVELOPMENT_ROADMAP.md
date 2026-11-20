# Development Roadmap

> **Status of this document:** the owner-approved phase structure from 2026-11-08 onward. It **supersedes the phase numbering** in PROJECT_PLAN.md (kept for history; mapping in §13). A phase listed here is a plan, not evidence that anything is implemented — implementation status lives in DEVELOPMENT_PROGRESS.md and is only marked complete with passing tests.
>
> Status values: **Completed** · **In Progress** · **Pending** · **Blocked** (with reason).

## 1. Overview

| Phase | Name | Status |
|---|---|---|
| 0 | Project Foundation | **Completed** |
| 1 | Security and Core Foundation | **In Progress — Blocked** on database verification (Neon not configured) |
| 2 | Student Information System | Pending (starts after Phase 1 sign-off) |
| 3 | Staff and HR Management | Pending |
| 4 | Academic Management | Pending |
| 5 | Fee and Finance Management | Pending |
| 6 | Parent and Student Portals | Pending |
| 7 | School Operations | Pending |
| 8 | Public School Website and CMS | Pending |
| 9 | AI School Assistant | Pending |
| 10 | Production Readiness | Pending |

### Rules that apply to every phase
- Work in vertical slices: schema → service (authorize → policy → transaction → audit) → server action/route → UI → tests → docs.
- **Database migrations are reviewed before execution**: `prisma migrate dev --create-only` → read the SQL → owner approval → apply to the `development` and `test` Neon branches only. Production only receives `prisma migrate deploy` of committed, reviewed migrations, after explicit approval.
- Every new permission goes into `src/lib/rbac/catalog.ts`, the seed, `docs/RBAC_MATRIX.md` (`npm run rbac:matrix`) and RBAC tests.
- A feature is complete only when: unit + integration tests pass on the Neon `test` branch, e2e passes on desktop/tablet/mobile with axe clean, CI is green, security review done, docs updated.
- No production secrets or production data in development, tests, docs or agent context. Free-tier policy (FREE_TIER.md) applies.

### Cross-cutting dependency notes (resolved from the proposed outline)
- **Classes & sections** appear in Phases 2 and 4. Resolution: Phase 2 owns the *master data* needed for enrollment (classes, sections, academic sessions); Phase 4 adds subjects, allocations and timetables on top.
- **School settings & academic-session management UI** are prerequisites of Phase 2 (ID formats, current session) and are delivered at its start.
- **Private file storage + PDF generation** are prerequisites of Phase 2 (student documents, ID cards) and are delivered at its start; reused by later phases.
- **Import/export** is delivered incrementally per module (student import in Phase 2, staff in 3, marks in 4, fees in 5), on one shared import pipeline.
- **Notifications & dashboards** grow per phase; the full notification system and analytics are completed in Phase 10's acceptance scope.
- **Public website is Phase 8**: until then `/` remains a placeholder (shows the configured school name and a sign-in link). The AI assistant (Phase 9) depends on Phase 8's CMS content.

---

## 2. Phase 0 — Project Foundation · **Completed**
- **Objectives:** agree architecture, stack, data model, security model, free-tier strategy and working method.
- **Features:** SYSTEM_ARCHITECTURE (ADR-001…026), DATABASE_SCHEMA/RELATIONSHIPS, AUTHENTICATION_AND_RBAC, SECURITY, FREE_TIER, UI/UX guidelines, testing strategy, Claude Code configuration (rules, skills, agents).
- **Dependencies:** none. **Database / API / UI requirements:** design only.
- **Security requirements:** threat model, data-protection approach (DPDP Act), secrets policy.
- **Tests required:** n/a (documentation).
- **Completion criteria:** documents reviewed by the owner — met.

## 3. Phase 1 — Security and Core Foundation · **In Progress — Blocked (database verification)**
- **Objectives:** a secure, tested platform every module builds on.
- **Features (implemented):** Argon2id auth, DB sessions (idle + 30-day absolute cap, `__Host-` cookie), lockout and rate limits, forced password change, self-service password reset (fragment token, no enumeration), RBAC (13 roles × 79 permissions, scopes), anti-escalation and Super Admin guards, user & role management UI, My account, audit log, AES-256-GCM field encryption, sequences, free-tier usage guard, scheduled cleanup, nonce CSP, shadcn/ui shell (desktop sidebar, mobile bottom nav), CI pipeline, local UI audit.
- **Dependencies:** Neon `development` and `test` branches (owner), Node 26.
- **Database requirements:** 15 tables (migration `20261108000000_init`) applied to development/test; seed on development only; pgvector enabled.
- **API requirements:** `/api/health` (+ deep), `/api/cron/cleanup`; server actions for auth, users, roles.
- **UI requirements:** login, forgot/reset, change password, dashboard, users, roles, account, 404, error, loading — responsive & accessible.
- **Security requirements:** all of SECURITY.md audit A1–A20 fixed (done); least-privilege DB role for audit log (KI-024).
- **Tests required:** unit (1,263 passing), integration (20, **pending DB**), e2e (42 offline passing; 33 **pending DB**), `pg_dump` restore drill.
- **Completion criteria:** `env:check` passes on Neon dev/test; migrations reviewed and applied to dev/test; seed on dev; all pending integration + e2e tests pass; Super Admin login verified on Neon; backup drill done.
- **Blocked by:** Neon configuration (owner action — follow docs/NEON_SETUP_GUIDE.md).

## 3a. Phase 2a — School Setup & Core Infrastructure · **In Progress** (offline work done, DB verification pending)
- Delivers the Phase 2 prerequisites above: school settings & academic-session UI, private/public file storage, PDF generation. Started 2026-11-09 at the owner's request **before Phase 1 database sign-off**; it shares Phase 1's blocker (Neon `test` branch).
- **Done offline:** see DEVELOPMENT_PROGRESS 2026-11-09. No schema change or new permission required.
- **Verification procedure:** [PHASE_2A_DB_VERIFICATION_CHECKLIST.md](PHASE_2A_DB_VERIFICATION_CHECKLIST.md) (gates G1–G7, owner vs. Claude steps).
- **Completion criteria:** `tests/integration/settings-files.test.ts` green on Neon `test`; settings screens audited at 360/768/1280 px; schema change and School Admin grants approved 2026-11-09 — migration `20261109000000` reviewed and applied to Neon `development`/`test` (separate approval), then its integration tests green; KI-035 closed.

## 4. Phase 2 — Student Information System · **Pending**
- **Objectives:** reliable student records from enquiry to enrollment, with permanent identifiers.
- **Features:** school settings & academic sessions UI; classes & sections (master data); admission workflow (multi-step form, guardians, documents, approval); student registration & profiles with change history; automatic, immutable student ID & admission number (`lib/sequence`); **alphabetical roll numbers generated at the admission-finalization stage** (preview → generate → finalize → audited correction, per session & section); student ID cards (front/back, QR verify page without PII, bulk PDF); student document management (private, encrypted storage); student import (XLSX/CSV).
- **Dependencies:** Phase 1 complete; private storage adapter; PDF generation; import pipeline.
- **Database requirements:** SchoolClass, Section, Student, Guardian, StudentGuardian, Admission, StudentDocument, StudentEnrollment, RollNumberBatch, StudentRollNumber, StudentStatusChange, MedicalRecord, GeneratedDocument, ImportJob/ImportRow (DATABASE_SCHEMA §3–4, 14). Aadhaar encrypted + HMAC.
- **API requirements:** server actions for admissions/students/roll numbers; authorized file download route (short-lived signed URLs); `GET /verify/:code` (public, no PII).
- **UI requirements:** mobile-first 5-step admission form with camera capture; student list (table/cards) + search; profile tabs; roll-number preview/finalize with type-to-confirm.
- **Security requirements:** `student.sensitive.read` for Aadhaar/medical; CHILDREN/SELF/ASSIGNED record policies; documents never public; exports redacted.
- **Tests required:** 50 concurrent admissions → unique IDs; duplicate-admission detection; collation tests for roll numbers; finalized batch immutability; ID-card PDF has no PII in QR; RBAC matrix for new endpoints; e2e on 3 devices.
- **Completion criteria:** all above tests green on Neon `test`; UI audit of new screens; docs updated.

## 5. Phase 3 — Staff and HR Management · **Pending**
- **Status (2026-11-19):** split into 3A HR core (built; verification pending KI-059) · 3B attendance & leave (M1–M5 built; M6 verification blocked on KI-059 / KI-073) · 3C payroll (plan proposed, decisions P1–P16 pending) — see PHASE_3_PLAN.md, PHASE_3B_PLAN.md, PHASE_3C_PLAN.md.
- **Objectives:** one person record for all staff, with leave and attendance feeding payroll.
- **Features:** employees (teaching & non-teaching), teacher profiles & qualifications, departments & designations, documents, service history, staff attendance (check-in/out, manual), leave types/balances/requests/approvals, payroll preparation (salary components & structures, monthly run, maker-checker, salary slips PDF), staff import.
- **Dependencies:** Phase 1; Phase 2's storage/PDF infrastructure.
- **Database requirements:** Department, Designation, Employee, TeacherProfile, EmployeeDocument, ServiceHistory, LeaveType, LeaveBalance, LeaveRequest, EmployeeAttendance, Holiday, SalaryComponent, SalaryStructure, EmployeeSalary, PayrollRun, Payroll, SalaryAdvance, SalaryPayment.
- **API / UI:** HR screens, attendance marking (mobile, one-handed), leave approval queue, payroll run wizard.
- **Security:** `employee.sensitive.read` (PAN/bank encrypted), `salary.self.read` SELF only, approver ≠ preparer, payroll audit trail; salaries never changed without approval.
- **Tests:** LOP/half-day proration, advance recovery, maker-checker, self-only slip access, snapshot immutability.
- **Completion criteria:** tests green on Neon `test`; payroll reports reconcile.

## 6. Phase 4 — Academic Management · **Pending**
- **Status (2026-11-20):** decisions AC1–AC20 approved (2026-11-19). 4A built (verification pending KI-059). **4B code complete** (grading, exams, marks entry and approval, lock, publication, report cards) — migration `20261122000000` awaiting SQL approval; verification on Test pending. **4C code complete** except marks import (promotion, homework, calendar; migration `20261123000000` awaiting SQL approval; marks import waits for dependency approval, KI-093). See PHASE_4_PLAN.md.
- **Objectives:** run the academic year: what is taught, when, and how students perform.
- **Features:** subjects & class-subject mapping, teacher allocation, timetables (no double-booking), academic calendar, homework & assignments, examinations (configurable CBSE grading), marks entry (theory/practical/internal, mobile grid), report cards (PDF), result publication, promotion to next session, marks import.
- **Dependencies:** Phase 2 (enrollments), Phase 3 (teachers).
- **Database requirements:** Subject, ClassSubject, TeacherAllocation, Period, TimetableSlot, Examination, ExamSubject, ExaminationMarks, GradeScale/GradeBand, ReportCard; homework/assignment and calendar models to be designed at phase start.
- **Security:** teachers ASSIGNED scope only; marks approval; results published only by `result.publish`.
- **Tests:** grade calculation vs configured scale; timetable clash prevention; promotion creates next-session enrollments; marks-entry RBAC.
- **Completion criteria:** a full term simulated end-to-end on the `test` branch.

## 7. Phase 5 — Fee and Finance Management · **Pending**
- **Objectives:** correct fees, no duplicate payments, immutable receipts.
- **Features:** fee categories & structures, invoices per period, concessions/scholarships/discounts, late fees, installments, counter collection (cash/UPI/bank), receipts (PDF), pending-fee & defaulter reports, financial reports; online payments (optional gateway, server-verified webhooks).
- **Dependencies:** Phase 2; Phase 7's transport fees join later.
- **Database requirements:** FeeCategory, FeeStructure(+Item), FeeConcession, StudentConcession, LateFeeRule, FeeInvoice(+Item), FeePayment, FeePaymentAllocation, FeeReceipt, PaymentGatewayEvent.
- **Security:** idempotency keys, unique transaction refs, webhook signature + replay protection, refunds audited, parents CHILDREN scope.
- **Tests:** concession/late-fee math, partial payments, duplicate prevention, webhook replay, reconciliation.
- **Completion criteria:** reconciliation report matches payments on the `test` branch.

## 8. Phase 6 — Parent and Student Portals · **Pending**
- **Objectives:** self-service access for families without exposing other students' data.
- **Features:** parent & student login (long sessions, mobile-first), student information, attendance, results, notices, fee status/payment, communication (messages/notifications).
- **Dependencies:** Phases 2, 4, 5.
- **Security:** CHILDREN/SELF policies enforced in every service; no admin navigation; rate limits.
- **Tests:** IDOR tests (parent A can't see child of parent B), e2e on phones.
- **Completion criteria:** portal journeys pass on mobile; RBAC matrix green.

## 9. Phase 7 — School Operations · **Pending**
- **Objectives:** day-to-day operations beyond academics and finance.
- **Features:** transport (vehicles, documents & expiry alerts, routes/stops, student allocation, transport fee), library (catalogue, copies, issue/return, fines), inventory & assets (maintenance, disposal), certificates (bonafide, character, transfer), school documents, school events (internal), remaining import/export reports.
- **Dependencies:** Phases 2, 3, 5.
- **Tests:** stock invariants under concurrency, route capacity, certificate serials, export redaction.

## 10. Phase 8 — Public School Website and CMS · **Pending**
- **Objectives:** a CMS-driven, fast, accessible public website.
- **Features:** homepage sections & ordering, about, academics, admissions info & enquiry form, notices, gallery, events, contact & map, downloads, menu management, publish workflow.
- **Dependencies:** Phase 1; public media storage (Cloudinary Free or local).
- **Security / cost:** sanitized rich text, CSP `frame-src` for maps only, rate-limited enquiry form, **data caching** for public pages (all pages render dynamically — ADR-024) so crawlers don't consume Neon compute.
- **Tests:** draft never public, sanitizer, Lighthouse mobile ≥ 90.

## 11. Phase 9 — AI School Assistant · **Pending**
- **Objectives:** answer visitor questions from approved public knowledge only.
- **Features:** Super Admin knowledge base (manual, PDF/DOCX, FAQs, activation), retrieval (FTS default; optional local embeddings), optional LLM behind daily cap, analytics.
- **Dependencies:** Phase 8 content.
- **Security:** strict separation from ERP data (lint-enforced), provider terms reviewed for minors, no paid usage without approval.
- **Tests:** fallback without LLM call, inactive/draft never retrieved, prompt-injection and personal-data refusal tests.

## 12. Phase 10 — Production Readiness · **Pending**
- **Objectives:** safe go-live.
- **Features / work:** full security review, performance & Neon budget review, accessibility audit of every screen, backup & restore drills (pg_dump + PITR), monitoring & alerting, least-privilege DB roles, production host selection (terms permit institutional use), deployment runbook, final acceptance testing with the school.
- **Completion criteria:** owner sign-off; restore drill recorded; CI + all suites green; KNOWN_ISSUES has no open High items.

## 13. Mapping from PROJECT_PLAN.md phases (history)

| Old phase (PROJECT_PLAN) | New phase |
|---|---|
| 0 Analysis & architecture | 0 |
| 1 Setup, DB, auth, RBAC | 1 |
| 2 Public website & CMS | **8** |
| 3 Admissions, students, IDs | 2 |
| 4 Classes/sections/academics, roll numbers | 2 (classes, sections, roll numbers) + 4 (subjects, timetable) |
| 5 ID cards & documents | 2 (student ID cards, documents) + 7 (certificates) |
| 6 Teachers & employees | 3 |
| 7 Attendance, leave, payroll | 3 (staff) + 4/6 (student attendance views) |
| 8 Fees & payments | 5 |
| 9 Transport | 7 |
| 10 Exams & report cards | 4 |
| 11 Library & inventory | 7 |
| 12 Import/export | incremental in 2–7 |
| 13 AI chatbot | 9 |
| 14 Notifications, analytics, settings | settings in 2; notifications/analytics across phases, completed in 10 |
| 15 Security audit & deployment | 10 |
