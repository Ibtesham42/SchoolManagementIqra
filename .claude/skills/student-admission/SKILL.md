---
name: student-admission
description: Use when building or changing the student admission form, admission workflow, guardian linking, document uploads, duplicate detection, admission approval, or admission receipts/confirmation documents.
---

# Student admission

## Responsibilities
Create a Student, Guardians, Admission, Documents and the session Enrollment atomically, with permanent identifiers and full audit.

## Workflow (service `createAdmission`)
1. `authorize(ctx, "admission.create")`.
2. Validate with `admissionSchema` (5 steps: student → guardians → academic → documents → review). The same schema is split per step on the client.
3. Duplicate check (before transaction, and enforced by unique index inside it):
   - Aadhaar HMAC match (if provided), or
   - same `fullNameNormalized` + `dob` + any guardian phone.
   Return `ConflictError` with the existing student's code (if caller may read it) — let the user confirm "this is a different student" only with `admission.approve`.
4. `prisma.$transaction`:
   - `sequence.next(tx, "admission_no:<year>")`, `sequence.next(tx, "student_id:<year>")` → format via settings (see student-id-generation skill).
   - Create Student (Aadhaar encrypted), upsert Guardians (reuse by phone for siblings), StudentGuardian links, Admission (status SUBMITTED or APPROVED per settings), StudentEnrollment (session/class/section), StudentDocument rows (files already uploaded to storage as PRIVATE with a pending reference).
   - `audit(tx, …)` with Aadhaar redacted.
5. After commit: notification `admission.created`; documents (receipt/confirmation PDF) generated on demand.
6. Roll number is NOT assigned here — see roll-number-generation skill (assigned at the end of the admission cycle, or appended for late admissions after finalization).

## Rules
- Admission number and student ID are immutable after creation; `updateStudent` must reject them.
- Edits after admission go through `updateStudent`, which writes an audit entry per changed field (history timeline reads AuditLog).
- Required documents are configurable in settings; missing ones mark the admission "documents pending", not invalid.
- Photo: re-encoded, max 2 MB upload, square crop to 600×600.
- The form must work on a 360px phone, with camera capture for documents.

## Examples
- Sibling admission: Guardian with phone `9xxxxxxxx1` exists → reuse it, link as FATHER; both children appear under the parent's portal.
- Re-admission of a withdrawn student: do not create a new Student; create a new Enrollment and a StudentStatusChange (WITHDRAWN → ACTIVE).
