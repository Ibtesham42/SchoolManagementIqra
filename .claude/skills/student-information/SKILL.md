---
name: student-information
description: Use for Phase 2 student records beyond the admission form itself — student profiles, guardians, session enrollments, class/section master data, status changes (promotion, transfer, withdrawal, alumni), documents, medical/emergency data, discipline and student import. Pairs with student-admission, student-id-generation and roll-number-generation.
---

# Student information management (Roadmap Phase 2)

## Data model (DATABASE_SCHEMA §3–4; build at phase start, migrations reviewed first)
- `Student` is session-independent and permanent (`studentCode`, `admissionNo` immutable). `StudentEnrollment` (one per student per session) carries class, section, status and the roll number link. History is never overwritten: promotion = new enrollment.
- `Guardian` rows are shared between siblings via `StudentGuardian` (relation, primary, emergency flags); a parent `User` links to one Guardian → CHILDREN scope.
- `StudentStatusChange` records ACTIVE → TRANSFERRED/WITHDRAWN/ALUMNI with reason and date; re-admission reuses the Student.
- `MedicalRecord` is 1:1 and restricted (`student.sensitive.read`); Aadhaar encrypted (`encryptField`) + HMAC (`lookupHash`) + last-4 for display.
- Documents: `StudentDocument` → `StoredFile` (PRIVATE, encrypted, authorized download only).

## Services & permissions
`student.read` (scoped: ALL / ASSIGNED via TeacherAllocation & class teacher / CHILDREN / SELF), `student.create`, `student.update`, `student.delete` (soft), `student.sensitive.read`, `student.document.read`, `student.promote`, `student.transfer`, `discipline.manage`. Every list/detail query goes through a policy that turns the scope into a Prisma `where`.

## UI
Profile with tabs (overview, guardians, enrollment history, documents, attendance/results later); list = table ≥ md, cards below; search by name/ID/admission no.; masked Aadhaar with audited "Reveal".

## Tests
Scope policies (teacher sees only assigned sections, parent only children), sensitive-field redaction in responses and exports, enrollment uniqueness per session, status-change history, soft delete hidden from lists, import idempotency (import-export skill).

## Out of scope here
Admission workflow details (student-admission), ID formats/sequences (student-id-generation), roll numbers (roll-number-generation), attendance and marks (Phase 4 / academic-examination).
