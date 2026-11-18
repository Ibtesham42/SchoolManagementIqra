---
name: teacher-hr-management
description: Use for Phase 3 staff work other than payroll calculation — employees (teaching and non-teaching), teacher profiles, departments, designations, staff documents, service history, staff attendance, holidays, leave types/balances/requests/approvals, and staff import. Pairs with payroll-management.
---

# Teacher & HR management (Roadmap Phase 3)

## Data model (DATABASE_SCHEMA §5–6)
- One `Employee` table for all staff (`type` TEACHING/NON_TEACHING); `TeacherProfile` 1:1 adds qualifications and specializations. `employeeCode` from `nextSequence` (immutable).
- PAN and bank account encrypted (`employee.sensitive.read` to reveal, audited).
- `ServiceHistory` is append-only (joined, promoted, transferred, resigned…). Resignation/termination changes `employmentStatus`, never deletes.
- `EmployeeAttendance` unique per employee per day (source MANUAL/BIOMETRIC/IMPORT); `Holiday` drives working days.
- Leave: `LeaveType` → `LeaveBalance` (per session) → `LeaveRequest` (PENDING/APPROVED/REJECTED/CANCELLED). Approval deducts balance in the same transaction and marks attendance ON_LEAVE.
- A staff `User` links to its Employee (`User.employeeId`) → SELF scope for own records and `salary.self.read`.

## Permissions
`employee.read`, `employee.manage`, `employee.sensitive.read`, `leave.request` (self), `leave.approve`, `attendance.employee.mark`, `attendance.employee.read`. Approver ≠ requester (enforce in policy).

## UI
Staff directory (table/cards), profile tabs (details, documents, service history, leave, attendance), one-handed daily attendance marking on phones, leave approval queue with balance shown.

## Tests
Leave overlap and half-day arithmetic, balance can't go negative, approval transaction (balance + attendance + audit), approver ≠ requester, self-scope access, sensitive-field redaction, attendance uniqueness, import duplicates.

## Hand-offs
Payroll inputs (paid days, LOP) → payroll-management. Teacher allocations/timetables → academic-examination (Phase 4).
