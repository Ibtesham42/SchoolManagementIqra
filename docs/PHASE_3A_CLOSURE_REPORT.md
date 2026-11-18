# Phase 3A — HR core: closure report (DRAFT)

**Status: DRAFT 2026-11-18 — code complete (M1–M5 on `main`, CI green); verification on the Test branch PENDING (blocked by KI-059).** Sections marked ⏳ are filled in by the M6 run. Owner sign-off at the end.

Plan and decisions: [PHASE_3_PLAN.md](PHASE_3_PLAN.md) §3a (H1–H14, Q1–Q3), ADR-036 (SYSTEM_ARCHITECTURE.md), schema proposal [PHASE_3A_M1_SCHEMA_PROPOSAL.md](PHASE_3A_M1_SCHEMA_PROPOSAL.md).

## 1. Delivered

| Milestone | Content | Commit (merge) |
|---|---|---|
| M1 | Schema: departments, designations, employees, teacher profiles, employee documents, append-only service history; `user.employee_id` FK. Applied to development and Test (drift 0) | `0dbeb78` (`a2f705a`) |
| M2 | Catalog (`employee.personal.read`, `employee.document.manage`; School Admin manages staff); master data; registration with permanent `EMP-{YYYY}-{SEQ:4}`; directory; profile (directory / personal tiers); personal & contact edits | `62c35c2` (`73b5014`) |
| M3a | Teacher profiles (H14); linking a login account to an employee (H2, Q2) | `5006064` (`6c498ab`) |
| M3b | `AuthContext.employeeId`; "My profile" (SELF, H7); class-teacher eligibility (H4); link safeguards (KI-065) | `501363b` (`dd968ab`) |
| M4a | Employment changes, reporting line (no loops), status — leaving / long-term leave / rejoin (H10–H13); service-history timeline | `9c2e555` (`9fcd1d1`) |
| M4b | Staff documents and photo (H5, H6, H8; S-15 lifecycle) | `7719df4` (`1e3ef3a`) |
| M5 | HR dashboard; staff directory CSV export | `5568ebe` (`4ee853c`) |
| Related | CI fix (`src/lib/storage` was never committed — KI-063); KI-061, KI-066; S-07 (append-only `audit_log`), S-15 (`purged_at`, purge job), S-20 (Claude deny list) | `c35b846`, `3f53541`, `fb1fecd` |

**Catalog:** 84 permissions / 13 roles / 291 default grants (RBAC_MATRIX.md). **Applied to Test and development** 2026-11-18 (KI-062, exact verification). Production untouched.

## 2. Requirements → evidence

| Decision | Implemented where | Unit evidence | Integration / browser ⏳ |
|---|---|---|---|
| H1 one school per installation | no `school_id` (migration guard) | `migration-phase3a-hr.test.ts` | — |
| H2 optional account link, `employee.manage` + `user.manage`, audited | `staff-accounts.service`, `identity.users.service` link helpers | `hr-teachers-accounts.test.ts` | `hr-accounts.test.ts` |
| H3 permanent employee code, joining year, `lib/sequence` | `hr.rules.planEmployeeCode`, `employees.service.registerEmployee` | `hr-rules.test.ts` | `hr-core.test.ts` (20 parallel) |
| H4 class teacher = ACTIVE TEACHING linked employee | `hr.tx`, `academic.sections.service` | — | `academic.test.ts` (H4 case), fixtures in 3 Phase 2 suites |
| H5 no Aadhaar/PAN/bank/medical | schema, document types | migration guard, `hr-document-routes.test.ts` | — |
| H6 directory vs personal tier | `hr.policy`, every service select | `hr-rbac.test.ts`, `hr-export-routes.test.ts` | `hr-core`, `hr-dashboard`, `hr-documents`, `hr-lifecycle` |
| H7 SELF "My profile", staff roles only | catalog `MY_PROFILE`, `employeeRecordAccess` | `hr-rbac.test.ts` | `hr-accounts.test.ts` ("My profile") |
| H8 documents & photo (HR Manager, School Admin) | `employee-documents.service`, routes | `hr-document-routes.test.ts` | `hr-documents.test.ts` |
| H9 master data, deactivate not delete; staff type from designation | `master-data.service` | `hr-rules.test.ts` | `hr-core.test.ts` |
| H10 reporting line, no cycles | `employee-lifecycle.changeReporting` | `hr-lifecycle.test.ts` | `hr-lifecycle.test.ts` (concurrent) |
| H11 status machine, leaving date + reason, rejoin | `hr.rules.planStatusChange` | `hr-lifecycle.test.ts` (full matrix) | `hr-lifecycle.test.ts` |
| H12 append-only history (application level) | only registration + lifecycle write events | — | `hr-lifecycle.test.ts` |
| H13 leaving offers account deactivation (explicit opt-in, `user.manage`) | `changeStatus` + `identity.deactivateUserTx` | `hr-lifecycle.test.ts` | `hr-lifecycle.test.ts` (rollbacks) |
| H14 free-text specialisations ≤ 10 × 60 | `teacherProfileSchema` | `hr-teachers-accounts.test.ts` | `hr-accounts.test.ts` |

## 3. Security reviews (security-auditor, read-only)

Per slice (details in DEVELOPMENT_PROGRESS.md): M2, M3a, M3b, M4a, M4b, M5 — **no Critical or High findings**; one Medium per M2 (appointment-type filter for directory readers) and M4a (deactivation checkbox pre-ticked, against H13), both fixed with regression tests; all Low findings fixed or recorded (KI-064…KI-068). Final cross-cutting review: §6.

## 4. Verification on Test ⏳

- [ ] KI-059: owner adds `TEST_TARGET_BRANCH_ID` / `TEST_TARGET_ENDPOINT_ID` to `.env`.
- [ ] Full integration suite on Test (`npm run test:integration -- --no-file-parallelism`): Phase 1/2/2B suites (incl. `security-fixes-2b`, class-teacher fixtures) + Phase 3A `hr-core` (9), `hr-accounts` (8), `hr-lifecycle` (8), `hr-documents` (4), `hr-dashboard` (2), `files-purge` (1). Result: ⏳
- [ ] Test verified clean afterwards (catalog 84/13/291 unchanged; fixtures removed).
- [ ] Signed-in browser review on Test: Super Admin, School Admin, Principal, Vice Principal, HR Manager, Librarian, Teacher/Class Teacher, Accountant, Parent — at 360 / 768 / 1280 px (LOCAL_UI_AUDIT.md). Result: ⏳

## 5. Open items carried forward

| ID | Item | Owner action |
|---|---|---|
| KI-059 | `.env` lines for the integration target | owner |
| KI-064 | Prisma typing gap in some integration queries | none (info) |
| KI-067 | Orphan-blob reconciliation needs storage listing | later |
| KI-068 | Document images keep metadata (also student documents) | decision |
| — | Live-document retention period (DPDP, KI-004) | with the school |
| — | Phase 3B (attendance & leave) and 3C (payroll, PAN/bank encrypted) | roadmap |

## 6. Final security review (security-auditor, read-only, 2026-11-18)

No Critical or High. **Medium M1** — approver ≠ subject depends on the actor's account link: self-unlinking now refused (fixed + integration test); the remaining gap for unlinked administrators is **KI-069 (owner decision)**; CHANGELOG wording corrected. **Low** — L1 personal/contact edits now also require the directory (no blind writes / id oracle; unit test); L2 self-verification of documents refused (unit test); teacher-profile self-edit accepted (professional data). **Info** — lock order: no cycle (comment corrected to state the employee → master-data share-lock invariant); API doc for `getTeacherProfile` corrected; personal-phone search in the URL → KI-070; SELF readers see their own leaving reason, remarks and "recorded by" — consistent with H7 (own personal data), to be confirmed at sign-off. Tier model, escalation paths and data minimisation: no issues found.

## 7. Sign-off

- [ ] Owner: Phase 3A accepted (date, name).
