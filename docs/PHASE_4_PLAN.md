# Phase 4 — Academic management: assessment and implementation plan

**Status: decisions AC1–AC20 APPROVED as recommended (owner, 2026-11-19).** Catalog change AC11 / AC12 made in code (84 / 13 / 305; database sync with KI-073). 4A-M1 migration `20261121000000` **approved and applied to development** 2026-11-19 (Test pending KI-059).

Phase 4 is large, so the plan splits it like Phase 3 (AC1): **4A** teaching structure and student attendance · **4B** examinations, grading, marks, report cards and results · **4C** promotion, homework, academic calendar and marks import.

**Open items carried in (not blockers for planning, but blockers for "complete"):**
- Phases 1, 2a, 2B, 3A and 3B have database verification pending: KI-059 (`.env` lines), KI-073 (grant sync).
- The 3C payroll SQL is awaiting review.
- Phase 4 builds on enrollments (Phase 2B) and teachers (3A), so 4A-M1 should be applied only after Phase 2B and 3A are verified on Test.

## 1. Starting point (verified from code)

- **Exists:**
  - `SchoolClass` (code, numericLevel −3…12, displayOrder).
  - `Section` per academic session, with capacity and `classTeacherId` → **User**. This is the interim reference from ADR-034: one class teacher per session, and the teacher's login must be linked to an ACTIVE TEACHING employee (3A M3b).
  - `StudentEnrollment` (student × session → section, composite FK), roll numbers per section.
  - `AcademicSession` lifecycle: PLANNED → ACTIVE → CLOSED.
  - `Holiday` (appliesTo ALL / STAFF / STUDENTS).
  - `GeneratedDocument` with type `REPORT_CARD`; `lib/pdf`, `lib/sequence`, `lib/csv`.
- **ASSIGNED scope today** (`academic.policy.ts`): only the sections a user is class teacher of, in sessions that are not CLOSED (S-02). The policy already says Phase 4 widens this to teacher allocations.
- **Permissions in the catalog:**
  - `academic.read` / `academic.manage`, `timetable.read` / `timetable.manage`.
  - `attendance.student.mark` / `attendance.student.read` (Teacher and Class Teacher at ASSIGNED; Parent at CHILDREN; Student at SELF).
  - `marks.enter` (ASSIGNED), `marks.approve` (Principal, Vice Principal), `result.read`, `result.publish` (Principal, Vice Principal), `student.promote` (School Admin).
  - **`exam.manage` and `reportcard.generate` are held by no role except Super Admin** (AC11, AC12).
- **Portals:** the Parent and Student roles hold scoped grants, but no parent/student portal screens exist yet, so results can't reach parents in Phase 4 (AC20).

## 2. Proposed design (summary)

| Area | Models (proposed) | Notes |
|---|---|---|
| Subjects (4A) | `Subject` (code, name any script, kind: SCHOLASTIC / CO_SCHOLASTIC, isActive, version) | School-defined; nothing seeded (AC2) |
| Class subjects (4A) | `ClassSubject` (academicSessionId, classId, subjectId, isOptional, sortOrder) · `StudentSubject` (enrollmentId, classSubjectId) for optional subjects | Per session and class; optional subjects chosen per student (AC3) |
| Teacher allocation (4A) | `TeacherAllocation` (academicSessionId, sectionId, classSubjectId, employeeId) | Points at **Employee** (TEACHING, ACTIVE). The teacher's login link gives `ctx.employeeId` (AC4). Source of subject-level ASSIGNED scope |
| Periods and timetable (4A) | `Period` (dayOfWeek, number, start, end, kind TEACHING / BREAK) · `TimetableSlot` (sectionId, periodId, classSubjectId, employeeId) | U(section, period) and U(employee, period, session): no double-booking (AC5) |
| Student attendance (4A) | `StudentAttendance` (enrollmentId, date, status PRESENT / ABSENT / LATE / HALF_DAY / EXCUSED, markedById, correctionReason?, version) | U(enrollment, date). Daily, by the class teacher (AC6, AC7); session-scoped through the enrollment |
| Grading (4B) | `GradeScale` (name, isActive) · `GradeBand` (scaleId, minPercent, maxPercent, grade, gradePoint?, remark?) | Data, not code; bands contiguous and non-overlapping (service + CHECKs) (AC8) |
| Exams (4B) | `Examination` (session, name, status DRAFT → SCHEDULED → MARKS_ENTRY → LOCKED → PUBLISHED, classes) · `ExamSubject` (exam × classSubject: date, maxTheory, maxPractical, maxInternal, passPercent?) | Each exam stands alone; weighted annual results later (AC9) |
| Marks (4B) | `ExaminationMarks` (examSubjectId, enrollmentId, theory?, practical?, internal?, status PRESENT / ABSENT / EXEMPT, enteredById, version) | Decimal(5,1); ABSENT counts 0, EXEMPT leaves the subject out of the maximum (AC10) |
| Report cards (4B) | `ReportCard` (examinationId, enrollmentId, snapshot JSON, documentId → GeneratedDocument) | A snapshot at publication; later scale edits never change it (AC15) |
| Promotion (4C) | `PromotionDecision` (fromEnrollmentId, decision PROMOTE / DETAIN / LEAVE, toClassId?, decidedById) | Creates next-session enrollments, never edits old ones (AC16) |
| Homework, calendar (4C) | `Homework` (section, classSubject, title, details, dueOn, attachment?) · calendar = holidays + exam dates (+ `AcademicEvent`) | AC17, AC18 |

**Pure modules (unit tested):**
- `grade-calc.ts`: totals, percentage, grade lookup, pass/fail. Exact arithmetic; rounding documented: percentage half-up to 2 dp; grade by band on the unrounded value.
- `timetable-rules.ts`: clash detection.
- `promotion-rules.ts`: next class by numericLevel.

## 3. Owner decisions needed (AC1–AC20)

| # | Decision | Recommendation |
|---|---|---|
| **AC1** | Split Phase 4? | **Yes: 4A / 4B / 4C** as above, each with its own schema review, verification and closure |
| **AC2** | Subjects: school-defined only, or a CBSE starter list? | **School-defined only** (rule 13). The form suggests common names as placeholders; nothing is saved |
| **AC3** | Subject mapping level and optional subjects | **Per session and class**, with an "optional" flag. Each student's optional subjects are chosen per enrollment (needed for marks). Section-level differences are out of scope |
| **AC4** | Teacher allocation reference | **Employee**, not User. A teacher is allocated only if they are an ACTIVE, TEACHING employee with a linked login. Their ASSIGNED scope becomes class-teacher sections ∪ allocated sections, and marks entry is limited to the allocated subject. `Section.classTeacherId` stays a User reference for now (no data migration in Phase 4); revisit later |
| **AC5** | Periods and timetable | A **school-defined period plan per weekday** and one timetable per section per session. The database prevents a section having two subjects in one period, or a teacher being in two sections in one period. Substitutions / cover lessons: **out of Phase 4** |
| **AC6** | Student attendance granularity and weekly off | **Daily** (not per period), marked by the **class teacher** on one phone screen (everyone present by default, like staff L7). Holidays: `Holiday` ALL / STUDENTS. **Separate student weekly-off setting** (often different from staff) |
| **AC7** | Student attendance corrections | The class teacher on the same day; afterwards only an `academic.manage` holder, with a reason (audited, reason not in the audit row). No payroll-style month lock |
| **AC8** | Grading scale | **Configurable scales.** A one-click template **"CBSE-style 8-point (A1–E)"** that the school reviews and saves; nothing is created automatically. Schools can define their own bands and grade points |
| **AC9** | Exam structure and weighting | **Each exam stands alone** in 4B (its own marks, grades and report card). A combined annual result with per-exam weights is a later milestone (4C or after) |
| **AC10** | Absent / exempt / medical | **AB** (absent) counts 0 and is shown "AB". **EX** (exempt, e.g. medical) excludes the subject from the maximum. Both need a reason only when changed after lock |
| **AC11** | Who manages exams (`exam.manage`)? | **School Admin and Principal** (catalog change, +2 grants; synced with approval) |
| **AC12** | Who generates report cards (`reportcard.generate`)? | **School Admin, Principal, and Class Teacher at ASSIGNED** (own section; catalog change, +3 grants) |
| **AC13** | Marks workflow | The teacher enters and **submits** per exam subject and section. A `marks.approve` holder (Principal, Vice Principal) approves, which **locks** it. Corrections after lock: `marks.approve`, with a reason (audited). Approver ≠ the teacher who entered |
| **AC14** | Ranks | **Off by default**; a school setting may enable rank in class. Ties share a rank |
| **AC15** | Report card content | **Scholastic results only** in 4B (subjects, marks, grades, attendance %, class-teacher remark). Co-scholastic areas (activities, discipline) come later. PDF on letterhead, verification code (`GeneratedDocument` REPORT_CARD), snapshot at publication |
| **AC16** | Promotion | 4C. At session end the class teacher proposes PROMOTE / DETAIN / LEAVE per student; a `student.promote` holder confirms in bulk. This creates enrollments in the next session (next class by numericLevel; section chosen) and never edits old enrollments. Roll numbers are regenerated in the new session |
| **AC17** | Homework / assignments | 4C. The teacher posts text plus an optional attachment (`lib/storage`, private) for allocated sections. **No online submission** until a student / parent portal exists |
| **AC18** | Academic calendar | 4C. Holidays (STUDENTS / ALL) + exam dates + optional `AcademicEvent`. Kept separate from public CMS events |
| **AC19** | Marks import (XLSX / CSV) | 4C. Needs `exceljs` / `papaparse` (dependency review and approval, import-export skill). Until then, mobile-friendly manual entry only |
| **AC21** (added 2026-11-19, open) | Does an EXCUSED day (e.g. medical) count against attendance %? | **Yes, counted as not attended, but shown separately** so the school can apply its own condonation rules (e.g. the 75 % rule with medical exemption). Alternative: leave EXCUSED out of the denominator. Implemented as recommended in `student-attendance.rules.ts`; one line to change |
| **AC20** | Parents and students seeing results | **Not in Phase 4** (no portal yet). `result.publish` marks results as published, and report cards can be printed / downloaded by staff. Portal delivery comes with the portal phase |

## 4. RBAC (proposed)

| Capability | Super Admin | School Admin | Principal | Vice Principal | Class Teacher | Teacher | Others |
|---|---|---|---|---|---|---|---|
| Subjects, class subjects, allocations, periods (`academic.manage`) | ✓ | ✓ | — | — | — | — | — |
| Timetable edit (`timetable.manage`) | ✓ | ✓ | — | — | — | — | — |
| Mark student attendance (`attendance.student.mark`) | ✓ | — | — | — | own section | own section (if class teacher) | — |
| Exams setup (`exam.manage`) | ✓ | **✓ (new)** | **✓ (new)** | — | — | — | — |
| Enter marks (`marks.enter` ASSIGNED) | ✓ | — | — | — | allocated subjects | allocated subjects | — |
| Approve / lock marks (`marks.approve`) | ✓ | — | ✓ | ✓ | — | — | — |
| Publish results (`result.publish`) | ✓ | — | ✓ | ✓ | — | — | — |
| Report cards (`reportcard.generate`) | ✓ | **✓ (new)** | **✓ (new)** | — | **own section (new)** | — | — |
| Promotion (`student.promote`) | ✓ | ✓ | — | — | propose only | — | — |

Catalog change (AC11, AC12): +5 grants → 84 / 13 / **305**. `ALLOWED_SCOPES` gains ASSIGNED for `reportcard.generate`; the academic policy implements it.

## 5. Milestones

| Milestone | Content | Gate |
|---|---|---|
| **4-M0** | Owner decisions AC1–AC20; Phase 2B / 3A verified on Test | Owner |
| **4A-M1** | Schema: Subject, ClassSubject, StudentSubject, TeacherAllocation, Period, TimetableSlot, StudentAttendance, student weekly-off setting; migration `--create-only` (offline diff), CHECKs, guard test | Owner approval of the SQL, then development, then Test |
| **4A-M2** | Subjects, class-subject mapping, optional subjects per student, teacher allocation; ASSIGNED scope widened (policy + tests over every role) | Unit + integration |
| **4A-M3** | Periods and timetable builder (mobile: one section-day at a time), clash prevention, teacher's own timetable | Integration incl. concurrent clash attempts |
| **4A-M4** | Student daily attendance (class teacher, mobile), corrections, section month register, attendance % | Integration + browser at 360 px |
| **4A-M5** | Verification on Test, security review, closure report | Owner sign-off |
| **4B-M1…M6** | Grading scales + calculator · exams and exam subjects · marks entry grid (mobile) · submit / approve / lock / correct · publish + report card PDF · verification | Each with integration; full term simulated on Test (roadmap completion criterion) |
| **4C-M1…M5** | Promotion · homework · calendar · marks import (after the dependency review) · verification | — |

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Teachers seeing or editing other sections' data | ASSIGNED scope from allocations + class-teacher sections, computed server-side; table-driven RBAC tests per role; NotFound for out-of-scope records |
| R2 | Timetable double-booking | Database unique constraints + service check; concurrency test |
| R3 | Grade errors from rounding or band gaps | Pure calculator with exact arithmetic; bands validated contiguous; golden tests per scale |
| R4 | Published results changing later | Snapshot report cards; marks locked before publish; corrections audited |
| R5 | Promotion damaging history | New enrollments only; old ones untouched; one transaction per batch |
| R6 | Two "assignment" sources (User class teacher vs Employee allocation) drifting | One policy function resolves both, using the login ↔ employee link (3A); revisit migrating `classTeacherId` to Employee after Phase 4 |
| R7 | Free-tier load (marks grids, attendance) | One batched transaction per screen save; pagination; no per-keystroke writes |
| R8 | Scope creep (portal, co-scholastic, weighting) | AC9, AC15, AC20 keep them out explicitly |

## 7. Documents to update when Phase 4 starts

DATABASE_SCHEMA §3/§6/§10 and DATABASE_RELATIONSHIPS (each M1), ADR row (allocation-based ASSIGNED scope; grading as data; report-card snapshot), RBAC_MATRIX / AUTHENTICATION_AND_RBAC (AC11, AC12), API_DOCUMENTATION, UI_UX_GUIDELINES (marks grid, attendance screen), DEVELOPMENT_ROADMAP, KNOWN_ISSUES, DEVELOPMENT_PROGRESS, CHANGELOG.
