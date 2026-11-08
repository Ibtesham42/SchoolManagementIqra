# Project Plan

## Phases and exit criteria

Each phase ends with: tests green · lint/typecheck clean · docs updated · DEVELOPMENT_PROGRESS.md entry · demo of every feature end-to-end (UI → API → DB).

| Phase | Scope | Exit criteria (verifiable) |
|---|---|---|
| 0 | Analysis, architecture, DB design, docs, Claude config | This document set reviewed and approved by the owner |
| 1 | Next.js scaffold, Tailwind/shadcn, Prisma + Postgres + pgvector, core models (identity, settings, sessions, sequence, audit, files), login/logout/reset, RBAC engine, seeded roles & permissions, ERP shell (responsive sidebar), Roles & Permissions UI, Users UI | Integration tests: login, lockout, session revocation, `authorize` matrix for every seeded role; e2e login on desktop + 360px viewport |
| 2 | CMS models + editor UI, public site pages (all 13 menu sections), homepage section ordering, notices/news/events/gallery/downloads, admission enquiry form, map embed, revalidation on publish | Public pages render only PUBLISHED content; editing in ERP reflects on site; XSS sanitizer tests |
| 3 | Admission form (multi-step, mobile), guardians, documents upload, admission approval, student ID + admission no. generation, admission receipt & confirmation PDF, student profile/search/lists, edit history | Concurrency test: 50 parallel admissions → 50 unique sequential IDs; duplicate detection (Aadhaar HMAC / name+DOB+guardian phone) |
| 4 | Classes, sections, subjects, allocations, timetable, roll-number generate → preview → finalize → correct | Pure-function tests for collation ordering; finalized batches immutable without `rollnumber.correct`; IDs unchanged |
| 5 | ID card templates (front/back), single/class/bulk PDF, print layout (CR80 on A4 sheets), QR verification page, certificates (bonafide, character, TC) | Visual snapshot tests of PDFs; QR page leaks no PII (test) |
| 6 | Employees, teacher profiles, departments/designations, documents, service history, allocations/workload, transfer/resignation, teacher ID cards | RBAC tests for employee.sensitive.read |
| 7 | Student & employee attendance (mobile marking UI), holidays, leave types/balances/requests/approvals, salary components/structures, payroll run workflow, salary slip PDF, advances, payments | Payroll calculation unit tests (LOP, half-days, advances, arrears); maker-checker enforced |
| 8 | Fee categories/structures/concessions/late fee rules, invoice generation, counter collection, receipts PDF, Razorpay online payments + webhooks, defaulters & outstanding reports | Webhook signature + replay tests; duplicate payment prevention; reconciliation test |
| 9 | Vehicles, documents & expiry alerts, drivers, routes/stops, student allocation, transport fee into invoices, maintenance & fuel | Capacity check; fee linkage tests |
| 10 | Exams, exam subjects, marks entry (mobile grid), internal/practical, grade scales (CBSE configurable), report cards, publication, promotion wizard | Grade calculation tests against configured CBSE scale; promotion creates next-session enrollments |
| 11 | Library (books, copies, issue/return, fines), inventory/assets (maintenance, disposal) | Stock invariants under concurrent issue |
| 12 | Import wizard (upload → map → validate → preview → confirm → report) for all listed modules; exports with permission/column filtering; reports hub | Import idempotency & duplicate tests; export column-redaction tests |
| 13 | Chatbot widget, knowledge CRUD, PDF/DOCX ingestion, chunking/embedding, FAQ, config, test console, analytics | Retrieval tests; "unknown → contact office" tests; isolation lint rule |
| 14 | Notifications (in-app + dispatcher interface), dashboards per role with charts, global search, settings panels | Role dashboards show only permitted aggregates |
| 15 | Security audit, performance, accessibility audit (axe), backup/restore drill, deployment | Restore drill documented; Lighthouse mobile ≥ 90 on public pages |

Phases 6 and 7 can start in parallel with 4–5 if more than one developer works on the project.

## Missing or ambiguous requirements (need owner decisions)

| # | Topic | Question | Current default |
|---|---|---|---|
| Q1 | Tenancy | Single school or several schools/branches? | Single school (ADR-002) |
| Q2 | Database for development | **Decided 2026-11-08:** Neon Free, separate `development` and `production` branches. | Resolved (ADR-016/017) |
| Q3 | Aadhaar | Is collecting Aadhaar actually required? (UIDAI discourages schools from making it mandatory.) | Optional, encrypted, masked |
| Q4 | Payment gateway | Razorpay, PayU, Cashfree, or other? Who owns the merchant account? | Razorpay adapter first |
| Q5 | Email/SMS | **Decided:** Resend Free (optional), `log` mode in dev. SMS deferred — no genuinely free provider. | Resolved (ADR-021) |
| Q6 | ID formats | Exact admission no. / student ID patterns and whether the counter resets per year | `{CODE}-{YYYY}-{SEQ4}`, per admission year |
| Q7 | Roll numbers | Tie-breaks for identical names; are late admissions appended at the end or does the class get re-sorted? | Tie-break DOB then student ID; late admissions appended after finalization |
| Q8 | Grading | CBSE scheme per class band (I–V descriptive, VI–VIII, IX–X, XI–XII) and term structure | Configurable scales; seed CBSE 8-point scale (A1–E) |
| Q9 | Payroll statutory | PF / ESI / Professional Tax / TDS needed? State for PT? | Configurable deduction components; no statutory automation in v1 |
| Q10 | Hostel | Is hostel needed? | Fee category only |
| Q11 | Languages | Hindi or other regional languages for public site/ERP? | English, i18n-ready |
| Q12 | Parent/Student portal | Is online fee payment by parents in scope for launch? | Yes (Phase 8) |
| Q13 | Data retention | Retention periods and DPDP consent flow | See SECURITY.md defaults |
| Q14 | AI provider | **Decided:** free only. Default FAQ + keyword search (no LLM). An LLM may be enabled only after the school reviews that provider's terms on minors/data use (Gemini free tier excluded — see FREE_TIER.md). | Resolved (ADR-020) |
| Q15 | Hosting & budget | **Partly decided:** free tiers for development; Vercel Hobby excluded for production (non-commercial terms). Production host still to be chosen: school-operated server vs. a host whose terms allow institutional use. | Open — needed before Phase 15 |
| Q16 | Private file storage (production) | Encrypted local disk on the school server, Backblaze B2 free 10 GB (card requirement to confirm), or Supabase Storage free? | Local encrypted disk in dev |
| Q17 | Node.js version | **Decided 2026-11-08:** Node 26 LTS. | Resolved |

## Risks

- Scope is very large; each phase is a multi-week effort. Mitigation: strict phase gates, vertical slices.
- Free-tier limits (FREE_TIER.md): Neon storage (~512 MB budget) and compute hours; Neon scale-to-zero cold starts; Resend 100/day. Mitigation: usage caps, warnings at 80 %, housekeeping jobs, files kept out of the DB.
- Free tiers can change terms or limits without notice. Mitigation: every service is optional and replaceable (ADR-016).
