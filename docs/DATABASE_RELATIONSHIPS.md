# Database Relationships

## Core spine

```
AcademicSession 1─< Section >─1 SchoolClass
       │               │ └─0..1 User (class teacher; ≤ 1 section per teacher per session)
       │               │
       │               └─< StudentEnrollment >─1 Student ─< StudentGuardian >─ Guardian
       │                        │                  │
       │                        ├─1 StudentRollNumber >─ RollNumberBatch (session+section)
       │                        ├─< StudentAttendance
       │                        └─< ExaminationMarks >─ ExamSubject >─ Examination
       │
       ├─< FeeStructure ─< FeeStructureItem >─ FeeCategory
       ├─< FeeInvoice ─< FeeInvoiceItem          FeeInvoice >─< FeePayment (via FeePaymentAllocation)
       │                                          FeePayment 1─1 FeeReceipt
       ├─< TransportRoute ─< TransportStop ─< StudentTransport >─ Student
       └─< TeacherAllocation >─ Employee, Section, Subject
```

### Phase 6A portal links (ADR-045)

```
User 0..1─1 Guardian   (user.guardian_id, unique, RESTRICT)  — one portal account per guardian; siblings via StudentGuardian
User 0..1─1 Student    (user.student_id, unique, RESTRICT)   — optional student account (P14)
User 1─< AccountActivation (CASCADE)
StudentGuardian.portal_access — per (student, guardian) custody block
FeeInvoiceItem >─0..1 FeePayment (waived_with / frozen_by, RESTRICT) — KI-105
```

## Rules

1. **Student is session-independent; StudentEnrollment is per session.** Class/section/roll number always come from the enrollment for the session in question. Promotion = new enrollment in the next session (old one → PROMOTED). This keeps history intact.
2. **One enrollment per student per session** (`U(studentId, academicSessionId)`).
3. **Roll numbers hang off the enrollment**, grouped by `RollNumberBatch(session, section)`. Regeneration replaces rows inside a DRAFT batch; a FINALIZED batch only changes through `rollnumber.correct` with an audit reason.
4. **Guardians are shared**: siblings link to the same Guardian rows; a parent User links to one Guardian, which gives `CHILDREN` scope over all linked students.
5. **Employee is the single person table for all staff.** TeacherProfile (1:1) adds teaching-specific fields. Drivers may reference an Employee or be external contractors. *(Phase 3A, migration `20261112000000` — SQL approved 2026-11-18, applied to development and Test 2026-11-18.)* Employee ─> Department and ─> Designation (master data, deactivated, never deleted); Employee.reportsToId ─> Employee (reporting line; no self-reporting by CHECK, no cycles by the service); Employee 1─< EmployeeDocument (each owns one PRIVATE StoredFile; one current photo); Employee 1─< EmployeeServiceEvent (append-only history). The class teacher stays a User reference (ADR-034); from M3 it must be a user linked to an ACTIVE TEACHING employee.
6. **User ↔ person links are optional 1:1**: `User.employeeId`, `User.studentId`, `User.guardianId` (at most one set). People can exist without logins. `User.employeeId` is an FK to Employee from Phase 3A (RESTRICT). Because Employee also references User (createdById and other actor columns), **user ↔ employee is the schema's only FK cycle**: the backup drill restores `user.employee_id` in a second step (`DEFERRED_FK_COLUMNS` in `scripts/db-tables.ts`).
7. **Fees**: invoices are generated from FeeStructure + StudentConcession + StudentTransport (transport fee from the stop). Payments allocate to one or more invoices; invoice `paidAmount`/status are recomputed in the payment transaction.
8. **Payroll**: PayrollRun (month) 1─< Payroll (slip per employee) 1─< SalaryPayment. Slip values are a **snapshot** (JSON earnings/deductions) so later structure changes never alter past slips.
9. **Exams**: Examination (session) ─< ExamSubject (class+subject, max marks) ─< ExaminationMarks (per enrollment). ReportCard aggregates per enrollment per exam/term.
10. **Files**: every upload is a StoredFile; domain tables reference `fileId`. Public CMS files are `visibility=PUBLIC`; everything else PRIVATE and served through an authorized route. Each file also records its **purpose** and **owning record** (`ownerType`, `ownerId`, polymorphic, no FK): a PRIVATE file is served only when the caller names that exact owner after its own record-scope check (files.service `canReadStoredFile`). SchoolSetting.logoFileId → StoredFile (SET NULL). GeneratedDocument.fileId → StoredFile (RESTRICT, unique) and the PDF's owner is the GeneratedDocument itself; GeneratedDocument.subject (e.g. Student) is polymorphic.
11. **Classes and sections** *(migration `20261110000000`, applied to **development** 2026-11-10 05:20Z; test pending)*: SchoolClass is session-independent master data (never deleted, deactivated instead); Section belongs to exactly one AcademicSession and one SchoolClass and is read-only once its session is CLOSED (service rule). Copying sections into a new session creates new Section rows — sections never move between sessions. The class teacher is an optional User reference (ADR-034); a partial unique index allows one class-teacher section per user per session. Future StudentEnrollment and RollNumberBatch reference Section with RESTRICT, so a section that ever had an enrollment cannot be hard-deleted.
12. **AuditLog** references entities polymorphically (`entityType`, `entityId`) — no FK, so audit survives soft/hard deletes.
13. **Chatbot tables have no FKs into ERP tables.** KnowledgeChunk → ChatbotKnowledge only.

## Delete behaviour

| Relation | onDelete |
|---|---|
| Child detail rows (FeeInvoiceItem, ImportRow, KnowledgeChunk, CMSSection, TransportStop) | Cascade |
| Anything referencing Student / Employee / AcademicSession / FeePayment | Restrict (these are soft-deleted, never hard-deleted) |
| Section.academicSessionId / classId / classTeacherId | Restrict (sessions and classes are never hard-deleted; users are deactivated, never hard-deleted — an assignment is never silently dropped) |
| Optional references (vehicleId on route) | SetNull |
| SchoolSetting.logoFileId → StoredFile; GeneratedDocument.generatedById / revokedById → User | SetNull |
| GeneratedDocument.fileId → StoredFile | Restrict (an issued document's PDF can't be hard-deleted) |
| User.employeeId → Employee; Employee → Department / Designation / reports-to Employee; TeacherProfile, EmployeeDocument, EmployeeServiceEvent → Employee; EmployeeDocument.fileId → StoredFile | Restrict (Phase 3A: employees are soft-deleted, master data deactivated; unlinking an account is explicit and audited) |
| Employee.createdById; EmployeeDocument.uploadedById / verifiedById; EmployeeServiceEvent.actedById → User | SetNull (actor references; the audit log keeps the actor label) |
| SalaryStructureItem → SalaryStructure / SalaryComponent; EmployeeSalary → Employee / SalaryStructure; PayrollSlip → PayrollRun / Employee / EmployeeSalary; PayrollAdjustment, SalaryPayment → PayrollSlip | Restrict (Phase 3C draft: payroll history is never hard-deleted) |
| EmployeeSalary.proposedById / decidedById; PayrollRun.preparedById / approvedById; PayrollAdjustment.createdById; SalaryPayment.paidById → User | SetNull (actor references; the audit log keeps the actor label) |
| ClassSubject → AcademicSession / SchoolClass / Subject; StudentSubject, StudentAttendance → StudentEnrollment (composite with session); TeacherAllocation, TimetableSlot → Section / ClassSubject / Period (composite with session) and → Employee | Restrict (Phase 4A draft: teaching history is never hard-deleted; the session travels with every link) |
| StudentAttendance.markedById → User | SetNull (actor reference) |
| GradeBand → GradeScale; Examination → AcademicSession / GradeScale; ExamSubject → Examination / ClassSubject; MarksSheet → ExamSubject / Section; ExaminationMarks → MarksSheet / StudentEnrollment; ReportCard → Examination / StudentEnrollment / GeneratedDocument (all composite with the session) | Restrict (Phase 4B draft: results history is never hard-deleted) |
| Examination.publishedById; MarksSheet.submittedById / approvedById; ExaminationMarks.enteredById → User | SetNull (actor references) |
| StudentConcession / StudentFeeCharge / FeeInvoice → StudentEnrollment by (student_id, academic_session_id); FeeStructureItem / StudentFeeCharge / FeeInvoice → FeeInstallment (composite with the session); FeeInvoiceItem → FeeInvoice / FeeCategory / StudentFeeCharge; FeePayment → Student; FeePaymentAllocation → FeePayment / FeeInvoiceItem / FeeInvoice | Restrict (Phase 5A draft). FeeStructureItem → FeeStructure and FeeConcessionCategory → FeeConcession: Cascade (a template's own rows) |
| StudentConcession.proposedById / decidedById; StudentFeeCharge.createdById; FeeInvoice.issuedById / cancelledById; FeePayment.collectedById / cancelledById → User | SetNull (actor references) |
| PromotionDecision → StudentEnrollment (from: composite with the session; to: the next-session enrollment) / SchoolClass; Homework → Section / ClassSubject (composite with the session); AcademicEvent → AcademicSession | Restrict (Phase 4C draft) |
| PromotionDecision.proposedById / confirmedById; Homework.postedById → User | SetNull (actor references) |
