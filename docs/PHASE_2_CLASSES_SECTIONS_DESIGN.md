# Phase 2 — Classes & Sections: technical design

Status: **IMPLEMENTED (2026-11-10). Migration applied to DEVELOPMENT only (05:20Z); test pending.**
Migration `20261110000000_phase2_classes_sections`: §9 steps 1–3 done on development (drift exit 0, `db:check` ✓). Catalog/seed changes (§3),
services, actions, UI (§7) and the unit tests (§8) are implemented and pass offline; integration and e2e
tests (§8) and the database steps (§9, items 2–6) are pending. KI-044 (app-wide transaction options) is
**not** changed — still the owner's decision before admissions. Assumptions A1–A3 implemented as proposed.
ADR: [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) ADR-034. Schema: [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) §3.

## 1. Owner decisions (2026-11-10)

| # | Decision |
|---|---|
| D1 | Class teacher = existing **User** now; Phase 3 links it to Employee without losing assignments |
| D2 | New permission **`academic.read`**: ALL for admin / principal / office roles, ASSIGNED for teachers |
| D3 | Default section capacity **40** — a configurable default, not a limit; each section has its own capacity |
| D4 | Class 11/12 **streams are separate classes** (Class 11 Science, Class 11 Commerce, …) |

## 2. Data model (migration draft)

| Table | Purpose | Key rules |
|---|---|---|
| `school_class` (SchoolClass) | Master list of classes; **not session-scoped**; never deleted (deactivate) | `code` unique (`^[A-Z0-9]+(-[A-Z0-9]+)*$`, ≤ 10, e.g. `C06`, `C11-SCI`); `name_key` unique (= lower(name)); `numeric_level` −3…12, not unique (streams share a level); optional `default_section_capacity` 1–200; `version` ≥ 1 |
| `section` (Section) | A class's section in **one academic session** | U(session, class, name_key); U(session, code); **partial U(session, class_teacher_id) WHERE class_teacher_id IS NOT NULL**; capacity 1–200 (required); FKs to session / class / user all RESTRICT; `version` ≥ 1 |
| `school_setting.default_section_capacity` | School-wide default for new sections | SmallInt, default 40, CHECK 1–200 |

**Capacity resolution for a new section:** value entered in the form → `SchoolClass.defaultSectionCapacity` → `SchoolSetting.defaultSectionCapacity` (40). The resolved number is stored on the section; later default changes never alter existing sections.

**Codes.** Class code: entered by the admin, uppercased, immutable once any section uses the class (service). Section code: derived `"<class code>-<NAME without spaces, uppercased>"` (e.g. `C06-A`, `C06-ROSE`), recomputed only while the section has no enrollment; collisions (e.g. "Rose Garden" vs "RoseGarden") are refused by U(session, code) with a clear message.

**Lifecycle.**
- Class: active ↔ inactive. An inactive class cannot get new sections; its existing sections are unaffected. Never deleted (no delete action; FK RESTRICT from section).
- Section: active ↔ inactive. An inactive section accepts no new enrollments (Phase 2 admissions). **Hard delete** only when the session is not CLOSED and no row references it (today: always true; after admissions: `StudentEnrollment`/`RollNumberBatch` FKs with RESTRICT make the database refuse it, and the service checks first to give a clear message).
- Session-aware: sections may be created/edited/deleted in **PLANNED** and **ACTIVE** sessions only; **CLOSED ⇒ read-only** (service rule, same source of truth as `settings.rules`).

**Copy sections from a previous session** (`copySectionsFromSession(from, to)`): one transaction; target session must be PLANNED or ACTIVE and different from the source; copies only **active** sections of **active** classes; carries name and capacity; **does not copy class teachers** (a new year needs a fresh assignment — avoids silently re-granting ASSIGNED access); skips any (class, name_key) that already exists in the target; returns `{ created, skipped }`. Idempotent: running it twice creates nothing the second time.

**Future enrollment / capacity.** `StudentEnrollment.sectionId → Section` (RESTRICT). Enrolling (or moving) a student: `SELECT … FROM section WHERE id = $1 FOR UPDATE` → count ACTIVE enrollments → refuse if `count >= capacity` → insert, all in the admission transaction (see §6).

**Phase 3 path (D1).** Employee rows link to users through the existing `User.employeeId`. `Section.classTeacherId` keeps pointing at the User, so no assignment is lost; TeacherAllocation (Phase 4) and an optional `classTeacherEmployeeId` (backfilled from `user.employee_id`, expand-only) can follow.

## 3. Permissions and seed (proposal — catalog NOT changed yet)

`academic.manage` stays the only write permission (Super Admin, School Admin). Review: assigning a class teacher widens that teacher's ASSIGNED scope (e.g. `student.read` / `student.update` for CLASS_TEACHER) — the assigning admin already holds those permissions at ALL scope, so this is not an escalation; it is audited.

New `academic.read` — "View classes and sections":

| Role | Scope | Via |
|---|---|---|
| SUPER_ADMIN | ALL | `ALL_PERMISSION_KEYS` (automatic) |
| SCHOOL_ADMIN | ALL | explicit grant |
| PRINCIPAL, VICE_PRINCIPAL | ALL | add to `READ_ACADEMIC` (used only by these two roles) |
| ADMISSION_OFFICER | ALL | explicit grant (admissions need the class/section list) |
| TEACHER, CLASS_TEACHER | **ASSIGNED** | add `["academic.read", "ASSIGNED"]` to `TEACHER` (CLASS_TEACHER inherits it) |
| ACCOUNTANT | — (proposed: add in Phase 5 with fee structures per class) | owner may grant now if wanted |
| HR_MANAGER, TRANSPORT_MANAGER, LIBRARIAN, PARENT, STUDENT | — | — |

ASSIGNED for `academic.read` (until TeacherAllocation exists in Phase 4) = sections where `classTeacherId = ctx.userId`, plus their class. `academic.policy.ts` turns the scope into a Prisma `where`.

Catalog totals: **81 permissions, 13 roles, 267 grants** (+1 permission, +7 grants).

**Seed gap found (must fix before seeding):** `prisma/seed-core.ts` creates grants only for roles created in that run and for system roles ("admin-edited roles are kept"). Re-seeding development would therefore give `academic.read` to SUPER_ADMIN only. Proposed rule: *for permissions created in this run, also create the catalog's default grants on existing roles* — safe, because no admin can have edited grants for a permission that did not exist. Audit it in `seed.apply` (`newPermissionGrantsCreated`). Run on development only after a G3-style approval.

Files to change at implementation: `src/lib/rbac/catalog.ts`, `prisma/seed-core.ts`, `docs/RBAC_MATRIX.md` (regenerate with `npm run rbac:matrix`), `docs/AUTHENTICATION_AND_RBAC.md` §3–4, tests asserting 80/13/260 (`seed-plan`, `rbac-matrix`, `integration-setup`, `tests/integration/catalog-setup.ts` and the three integration suites' comments), nav item "Classes" gated on `academic.read`.

## 4. Audit events (same transaction as the change; `entityType` / `entityId`)

| Action | Entity | before | after |
|---|---|---|---|
| `class.create` | SchoolClass / id | — | code, name, numericLevel, displayOrder, defaultSectionCapacity, isActive |
| `class.update` | SchoolClass / id | changed fields only + version | changed fields only + new version |
| `class.status_change` | SchoolClass / id | { isActive } | { isActive } |
| `section.create` | Section / id | — | academicSessionId, classId, name, code, capacity, classTeacherId |
| `section.update` | Section / id | changed fields + version | changed fields + new version |
| `section.status_change` | Section / id | { isActive } | { isActive } |
| `section.class_teacher_assign` | Section / id | { classTeacherId: previous or null } | { classTeacherId } |
| `section.class_teacher_unassign` | Section / id | { classTeacherId } | { classTeacherId: null } |
| `section.delete` | Section / id | full row (no personal data) | — |
| `section.copy_from_session` | AcademicSession / target id | { fromSessionId } | { created, skipped, sectionIds (≤ 200) } |
| `settings.default_capacity_update` | SchoolSetting / default | { defaultSectionCapacity } | { defaultSectionCapacity } |

No sensitive fields exist on these tables; user references are ids only (never names/emails).

## 5. Validation (`src/modules/academic/academic.schemas.ts`, Zod `.strict()`, shared by forms, actions, future import)

- **Class code:** trim → uppercase → `^[A-Z0-9]+(-[A-Z0-9]+)*$`, 1–10.
- **Class name:** trim, collapse inner whitespace, printable ASCII only, 1–60; `nameKey = name.toLowerCase()` (identical to SQL `lower()` for ASCII — the DB CHECK enforces it).
- **Section name:** trim/collapse, `^[A-Za-z0-9]+( [A-Za-z0-9]+)*$`, 1–20; `nameKey = lower`; code derived (§2).
- **Numbers:** `numericLevel` int −3…12; `displayOrder` int 0…999; capacities int 1–200; `version` int ≥ 1 (required on every update).
- **Ids:** cuid2 strings; `academicSessionId` must exist; class must be active for new sections.
- **Class teacher:** user exists, `isActive`, `deletedAt IS NULL`, holds role TEACHER or CLASS_TEACHER (checked inside the transaction); otherwise `ValidationError("Choose an active teacher.")`.

## 6. Concurrency and transactions

- **Every write:** `authorize(ctx, "academic.manage")` → Zod parse → `prisma.$transaction(async (tx) => …)` → checks → write → `audit(tx, …)`. Errors: `NotFoundError`, `ValidationError`, `ConflictError`; never Prisma messages.
- **Session state:** section writes first run `SELECT status FROM academic_session WHERE id = $1 FOR SHARE` (typed `tx.$queryRaw`). A concurrent session status change (an UPDATE of that row, ADR-029) waits until the section transaction commits, so a section can never be created in a session that closed mid-flight; then refuse if `status = 'CLOSED'`.
- **Duplicates:** unique indexes are the source of truth. Map P2002 via `uniqueViolationInfo` → `ConflictError` with a field-specific message. **Gap:** `uniqueViolationInfo` maps constraint names only of the form `<table>_<column>_key`; the composite and partial indexes (`section_academic_session_id_class_id_name_key_key`, `section_session_class_teacher_key`) must be recognised by index name — extend `db-errors.ts` (unknown names must still rethrow).
- **Optimistic concurrency:** `updateMany({ where: { id, version }, data: { …, version: { increment: 1 } } })`; `count === 0` → `ConflictError("This section was changed by someone else. Reload and try again.")`. Forms carry `version` in a hidden field. Same for SchoolClass.
- **Capacity reduction:** inside the update transaction, lock the section (`FOR UPDATE`) and refuse a capacity below the current ACTIVE enrollment count (0 until admissions exist; the check ships now so it can't be forgotten).
- **Enrollment (Phase 2 admissions):** lock section row `FOR UPDATE` → count ACTIVE enrollments → compare with capacity → insert enrollment → audit, one transaction. Inactive section or closed session → refused.
- **Copy from session:** single transaction, `FOR SHARE` on both session rows, `createMany({ skipDuplicates: true })` against U(session, class, name_key) so concurrent copies cannot duplicate; counts from the result.

**Before admissions (blockers for KI-010 / 50 simultaneous admissions):**
1. **KI-044** — application transactions use Prisma's default `maxWait` 2 s / `timeout` 5 s with a pool of 5; bursts fail with "Unable to start a transaction". Set explicit `transactionOptions` in `src/lib/db.ts` (e.g. maxWait 10 s, timeout 15 s), keep transactions short (no Argon2/PDF work inside), and size the pool for Neon's pooler. Test: 50 concurrent section-capacity enrollments against the test branch → exactly `capacity` succeed, the rest get a clear "section full" error, no deadlocks or timeouts.
2. **KI-010** — the 50-concurrent-admissions and duplicate-detection integration tests are written with the admission module, after (1).

## 7. Service / API / UI (proposal)

- `src/modules/academic/`: `classes.service.ts` (`listClasses`, `getClass`, `createClass`, `updateClass`, `setClassActive`), `sections.service.ts` (`listSections(sessionId, classId?)`, `getSection`, `createSection`, `createSectionsBulk` (e.g. A–D), `updateSection`, `setSectionActive`, `deleteSection`, `assignClassTeacher`, `unassignClassTeacher`, `copySectionsFromSession`, `listEligibleClassTeachers`), `academic.schemas.ts`, `academic.policy.ts`, `academic.rules.ts` (pure: codes, capacity resolution, session editability — unit-tested). Settings: `updateDefaultSectionCapacity` in settings.service (`settings.manage`).
- Server actions (≤ 30 lines each) under `src/app/erp/academic/…`; no REST endpoint yet (added with import).
- UI (360 px first, UI_UX_GUIDELINES): `/erp/academic/classes` (table ≥ md, cards below; single-column create/edit form; activate/deactivate with confirm) and `/erp/academic/sections?session=` (session switcher defaulting to current; sections grouped by class: name, code, capacity, enrolled 0/40, class teacher, status; "Add sections A–D"; "Copy from previous session"; read-only banner for CLOSED sessions; 44 px touch targets). "Default section capacity" field on the Settings page.
- **Import readiness:** student import resolves a section by **class code + section name** in the chosen session (U(session, class, name_key)); case-insensitive; rejects inactive classes/sections and full sections per row; a downloadable reference sheet lists valid codes/names. Classes/sections themselves are entered manually (small, rarely changing).

## 8. Tests

**Unit (offline):** schemas (code/name normalisation, ASCII rule, ranges, `.strict()` extra keys); `academic.rules` (section-code derivation, capacity resolution order, CLOSED read-only, capacity-below-enrolled refusal); policy scope → `where` (ALL vs ASSIGNED); catalog counts 81/13/267 and the full RBAC matrix; seed plan with the new-permission grant rule; `db-tables` (done in this draft); **static migration test** `tests/unit/migration-phase2-classes.test.ts`: single transaction, expand-only (no DROP/RENAME), every CHECK present with the exact expression, 3 FKs RESTRICT, partial index has `WHERE (class_teacher_id IS NOT NULL)`, generated statements ⊂ migration (as `migration-phase2a.test.ts`), `previewFeatures` contains `partialIndexes`; `db-errors` recognises the new index names.

**Integration (Neon test branch, after G4/G5-style approval):** create/update/deactivate class and section; duplicate code/name (case-insensitive) → ConflictError; **two concurrent creates of the same section → exactly one succeeds**; stale `version` → ConflictError; CLOSED session refuses every section write; session closed concurrently with a section create → serialized (no section in a closed session); class-teacher rules (inactive user, non-teacher role, second section same session → refused; same teacher in a different session → allowed); copy-from-session idempotent and skips existing; capacity CHECK and FK RESTRICT enforced by the DB; audit row per write in the same transaction (rollback leaves none); **RBAC: every action returns 403 for Teacher, Accountant, Parent; Teacher reads only their own section; School Admin full access**.

**E2E (Playwright, 360/768/1280):** class create/edit/deactivate; sections for the current session; add A–D; copy from previous session; assign/unassign class teacher; CLOSED session read-only; axe scan of both screens.

## 9. Migration verification plan

1. Offline (done in this draft): `prisma format` / `validate`; SQL generated with `migrate diff --from-schema --to-schema` (no shadow database); 13/13 generated statements present in the migration; lint, typecheck, check:deps, `npm test` 29 files / 1,788 ✓.
2. Owner reviews the SQL and approves.
3. G2-style on **development**: target check, restore point, `npm run db:deploy` (applies only this migration), `db:check` (18 tables; extend `scripts/db-check.ts` with the new CHECKs/FKs first), drift `migrate diff --from-config-datasource --to-schema` → **exit 0** (proves the partial index is understood), `migrate status` up to date.
4. Seed-core fix + catalog change → G3-style seed sync on development.
5. G4/G5-style on **test**: deploy, `db:check`, integration suite.
6. Update DATABASE_SCHEMA (remove "not applied"), DEVELOPMENT_PROGRESS, CHANGELOG, KNOWN_ISSUES.

## 10. Assumptions and risks

| # | Item | Mitigation |
|---|---|---|
| A1 | "Teacher role" = TEACHER **or** CLASS_TEACHER system role (CLASS_TEACHER inherits Teacher grants) | Owner to confirm; custom roles are not eligible |
| A2 | Office roles for `academic.read` = SCHOOL_ADMIN, PRINCIPAL, VICE_PRINCIPAL, ADMISSION_OFFICER; ACCOUNTANT deferred to Phase 5 | Owner to confirm |
| A3 | Copy-from-session does not copy class teachers | Owner to confirm |
| A4 | Class/section names are ASCII (letters/digits; class names printable ASCII) | Keeps DB `lower()` and JS identical; revisit if names in Indian scripts are needed |
| R1 | `partialIndexes` is a Prisma **preview** feature | Pinned Prisma 7.10.1; drift check after apply must be exit 0; fallback = plain `@@unique([academicSessionId, classTeacherId])` (identical NULL semantics in Postgres) |
| R2 | Migration SQL is verified offline only (no local Postgres); syntax errors would surface at apply time | Whole migration is one transaction — any error leaves development unchanged; apply to development first |
| R3 | `db:check` on development will report the 2 new tables missing until the migration is applied (`db-tables.ts` already lists them) | Expected; apply or revert together |
| R4 | Seed would not grant `academic.read` to non-system roles | Seed-core rule in §3 before any seed run |
| R5 | `uniqueViolationInfo` doesn't map composite/partial index names | Extend db-errors with tests (§6) |
| R6 | KI-044 transaction timeouts under admission bursts | Fix + concurrency test before admissions (§6) |
| R7 | Rollback after data exists | Neon point-in-time restore (G6-C proven); manual DROP only while tables are empty (SQL in the migration header) |
