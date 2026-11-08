# Database Relationships

## Core spine

```
AcademicSession 1─< Section >─1 SchoolClass
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

## Rules

1. **Student is session-independent; StudentEnrollment is per session.** Class/section/roll number always come from the enrollment for the session in question. Promotion = new enrollment in the next session (old one → PROMOTED). This keeps history intact.
2. **One enrollment per student per session** (`U(studentId, academicSessionId)`).
3. **Roll numbers hang off the enrollment**, grouped by `RollNumberBatch(session, section)`. Regeneration replaces rows inside a DRAFT batch; a FINALIZED batch only changes through `rollnumber.correct` with an audit reason.
4. **Guardians are shared**: siblings link to the same Guardian rows; a parent User links to one Guardian, which gives `CHILDREN` scope over all linked students.
5. **Employee is the single person table for all staff.** TeacherProfile (1:1) adds teaching-specific fields. Drivers may reference an Employee or be external contractors.
6. **User ↔ person links are optional 1:1**: `User.employeeId`, `User.studentId`, `User.guardianId` (at most one set). People can exist without logins.
7. **Fees**: invoices are generated from FeeStructure + StudentConcession + StudentTransport (transport fee from the stop). Payments allocate to one or more invoices; invoice `paidAmount`/status are recomputed in the payment transaction.
8. **Payroll**: PayrollRun (month) 1─< Payroll (slip per employee) 1─< SalaryPayment. Slip values are a **snapshot** (JSON earnings/deductions) so later structure changes never alter past slips.
9. **Exams**: Examination (session) ─< ExamSubject (class+subject, max marks) ─< ExaminationMarks (per enrollment). ReportCard aggregates per enrollment per exam/term.
10. **Files**: every upload is a StoredFile; domain tables reference `fileId`. Public CMS files are `visibility=PUBLIC`; everything else PRIVATE and served through an authorized route.
11. **AuditLog** references entities polymorphically (`entityType`, `entityId`) — no FK, so audit survives soft/hard deletes.
12. **Chatbot tables have no FKs into ERP tables.** KnowledgeChunk → ChatbotKnowledge only.

## Delete behaviour

| Relation | onDelete |
|---|---|
| Child detail rows (FeeInvoiceItem, ImportRow, KnowledgeChunk, CMSSection, TransportStop) | Cascade |
| Anything referencing Student / Employee / AcademicSession / FeePayment | Restrict (these are soft-deleted, never hard-deleted) |
| Optional references (classTeacherId, vehicleId on route) | SetNull |
