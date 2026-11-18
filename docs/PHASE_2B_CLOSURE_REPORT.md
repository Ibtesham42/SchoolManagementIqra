# Phase 2B — Admissions & Student Management: closure report

**Status: DRAFT FOR OWNER REVIEW (2026-11-10). Phase 2B is NOT declared closed.** Decision items are in §7.
Design: [PHASE_2B_STUDENTS_DESIGN.md](PHASE_2B_STUDENTS_DESIGN.md) (decisions D1–D12). Evidence: [DEVELOPMENT_PROGRESS.md](DEVELOPMENT_PROGRESS.md) (2026-11-10 entries), [LOCAL_UI_AUDIT.md](LOCAL_UI_AUDIT.md) §21, [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## 1. What was delivered

| Slice | Content | Status |
|---|---|---|
| S0 | Owner decisions D1–D12, D11 transaction settings | ✓ |
| S1 | Migration `20261111000000` (10 tables) | ✓ applied to development (drift 0) and Test (drift 0) |
| S2 | RBAC catalog: `student.document.manage`, Principal `admission.approve` → **82 permissions / 13 roles / 271 grants** | ✓ in code; Test synced (owner-approved); **development not synced** (§5) |
| S3 | Admissions: drafts, 6-step form, submit (`APP-{SESSION}-{SEQ}`), review, return, reject, duplicate warnings | ✓ |
| S4 | 10 MB private upload route (KI-048), documents, photo via `sharp` (EXIF/GPS stripped), scoped downloads | ✓ (applications) |
| S5 | Approval = registration in one transaction (IDs, guardians, enrollment, exact capacity), busy handling | ✓ |
| S6 | Roll numbers: preview → draft → finalize, append on later admissions, corrections | ✓ |
| S7 | Student directory, profile, field-level edits, leaving workflow, CSV export, scoped photo/document reads | ✓ |
| S8 | Test-branch integration, concurrency, signed-in browser review, docs | ✓ partly — see §4 |

## 2. Verification evidence

| Check | Result |
|---|---|
| Unit tests | **44 files / 2,196 tests ✓** (lint, typecheck, check:deps 181 files, `next build` ✓) |
| Integration — full run on Test (11 files, 77 tests) | 75 ✓, 2 ✗ (both KI-010, test-design timeout) |
| Integration — admission-approval suite after the KI-010 test fix | **7 / 7 ✓** (368 s); 50 simultaneous approvals ✓ in 179.6 s — 50 distinct student IDs and admission numbers, exact capacity, no partial registrations |
| Phase 2 / 2B suites (academic, admissions, documents, roll numbers, student records, settings/files, identity, Phase 1, seed) | ✓ on Test |
| Signed-in browser review, S7 screens (Test) | **8 roles × 360 / 768 / 1280 ✓** (directory, profiles, editing limits, leaving with roll number retained, CSV permissions incl. Accountant refused, Parent/Student refused, menu visibility and highlighting) |
| KI-058 HTTP statuses (Test, production build) | **11 / 11 ✓** — existing 200, missing 404, unauthorized 200 not-permitted (no data), out-of-section 404, unauthenticated 307 → `/login` |
| Signed-out checks (development) | 28 / 28 ✓, database unchanged |
| Data hygiene on Test | All synthetic data removed in audited single-transaction cleanups (25, 62 + 1 update, 28 rows); Test verified clean; audit history and file records kept |

## 3. Issues found and fixed during Phase 2B verification

| Issue | Fix |
|---|---|
| Parent / Student saw a dead "Students" menu link | Menu shows Students only for ALL / ASSIGNED scope; no grant changed |
| Principal grant not added by the seed to an existing role (by design) | Owner-approved single grant on Test with audit |
| KI-010 test exceeded its budget and left data behind | Test-only fix: separate fixture hook, tracked approvals, session-scoped cleanup, 600 s budget |
| My S7 integration cleanup crashed after a failed setup | Guarded |
| KI-058 missing ERP records returned HTTP 200 | `src/app/erp/loading.tsx` removed; static guard + regression tests |
| Orphaned dev-server processes after stopping tasks | Stopped with owner approval (operational, not product) |

## 4. Planned S8 items not done

| Item (design §9 S8) | State |
|---|---|
| **Security-auditor review** of auth/RBAC, uploads, downloads, exports (required by `.claude/rules/security.md`) | **Not done** |
| Committed Playwright E2E specs × 3 devices **with axe** | **Not done** — the browser review used ad-hoc Playwright scripts (evidence in the session scratchpad); no axe scan of the new screens |
| Full integration suite re-run in one pass after the KI-010 fix | Not done (only the approval suite was re-run; others passed in the earlier full run) |
| Document/photo upload and download through the browser | Not exercised in the S8 runs (no uploads); route tests cover the security behaviour |
| Exact busy/retry counts in the 50-approval test | Not recorded |

## 5. Environment state

| Environment | State |
|---|---|
| **Development** | Migrations applied (Phase 2, 2B). **Catalog not synced**: `academic.read`, `student.document.manage` grants and Principal `admission.approve` are missing there until an owner-approved seed sync or Roles-UI change — School Admin / Admission Officer can't use the class pickers, nobody but Super Admin uploads documents, Principal can't approve. No school data. |
| **Test** | Migrated, catalog 82 / 13 / 271, clean (no synthetic data). |
| **Production** | Never accessed. Nothing deployed. |
| **Git** | **Nothing committed** — Phase 2A, Phase 2 and Phase 2B work is in the working tree only (KI-005). |

## 6. Known limitations carried forward

- **KI-057 (by design):** no re-admission of a student who left; no document upload after registration; no guardian linking/unlinking on an existing student; field-edit history only in the audit log.
- **Deferred roadmap items:** student import (XLSX/CSV, dependency review), ID cards and QR verification page (R7, R8).
- **KI-056:** `sharp` verified on the Windows standalone build only; Linux build to verify before deployment.
- **KI-058 trade-off:** no loading skeleton during ERP navigation.
- **KI-053:** concurrent session-close vs section write is designed to serialize but not automated.
- **Documentation housekeeping:** several older entries (KI-001, KI-011, KI-016, KI-021, KI-031, KI-036, KI-044) and the roadmap table (Phase 1 "Blocked", Phase 2 "Pending") predate the Test-branch runs and need status updates; the Phase 2B design status line still says S8 pending.

## 7. Recommendation and owner decisions

Phase 2B's functionality is complete and verified on Test. **Recommended before declaring it closed:**
1. **Security-auditor review** of the Phase 2B changes (required by project rules) — read-only, no database.
2. **Commit approval** for the accumulated Phase 2A / 2 / 2B work (it currently exists only in the working tree).
3. **Development catalog sync** (seed sync or Roles UI) — so the delivered screens work for School Admin, Admission Officer and Principal on development.

Optional before or during Phase 3: committed E2E specs with axe for the S7 screens; one full integration re-run; the documentation housekeeping in §6.
