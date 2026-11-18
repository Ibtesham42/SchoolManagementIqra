# Phase 3B — Staff attendance and leave: assessment and implementation plan

**Status: decisions L1–L12 APPROVED (owner, 2026-11-18). 3B-M1 schema APPLIED to development and Test 2026-11-18 (migration `20261119000000`, drift 0). 3B-M2 (leave set-up) implemented 2026-11-18 — unit tests pass; integration suite written, runs on Test once KI-059 is fixed. 3B-M3 (leave requests, approval queue, cancellation, transactional balances, My leave) implemented 2026-11-19; KI-071 resolved. Integration suites run on Test once KI-059 is fixed. Next: 3B-M4 (attendance marking, L7/L8; needs the L9 SELF grants on the databases).** Deviation recorded at M1: overlapping leave is prevented by the service under the employee row lock (no `btree_gist` exclusion constraint). Phase 3 split (PHASE_3_PLAN.md §1.3 B6): 3A HR core (done; M6 verification pending KI-059) · **3B attendance & leave (this plan)** · 3C payroll.

## 1. Starting point (verified from code)

- **Built in 3A:** one `Employee` per staff member, `AuthContext.employeeId` (SELF), department / designation, status machine (`ON_LEAVE` is informational today), service history, dashboard.
- **Permissions already in the catalog (no grants change yet):** `leave.request` (all staff roles at ALL — meant as "my own"), `leave.approve` (Super Admin, Principal, Vice Principal, HR Manager), `attendance.employee.mark` (Super Admin, HR Manager), `attendance.employee.read` (Super Admin, School Admin, Principal, Vice Principal, HR Manager).
- **Planned models (DATABASE_SCHEMA §5–6):** `LeaveType`, `LeaveBalance`, `LeaveRequest`, `EmployeeAttendance`, `Holiday`. None exist yet.
- **Hand-off to 3C:** paid days, loss-of-pay (LOP) days and half-days per month feed payroll; attendance for a payroll month must be lockable.

## 2. Proposed design (summary)

| Model | Fields (proposed) | Notes |
|---|---|---|
| `LeaveType` | code, name (any script, like departments), isPaid, annualQuota (Decimal 4,1), allowHalfDay, carryForwardMax (Decimal 4,1, 0 = none), appliesTo (ALL / TEACHING / NON_TEACHING), isActive, version | Master data, deactivate only. **No seeded types** (rule 13 — the school creates CL/EL/… with its own quotas) |
| `LeaveBalance` | employeeId, leaveTypeId, **leave year** (L1), allotted, carriedForward, used, version | U(employee, type, year). Opening balances by HR (audited) |
| `LeaveRequest` | employeeId, leaveTypeId, fromDate, toDate, halfDay (FIRST/SECOND/null, single-day only), days (Decimal 4,1 — computed), reason, status (PENDING / APPROVED / REJECTED / CANCELLED), requestedById, decidedById?, decidedAt?, decisionNote?, version | No overlap with another PENDING/APPROVED request (exclusion constraint on a date range — raw SQL, reviewed) |
| `EmployeeAttendance` | employeeId, date, status (PRESENT / ABSENT / LATE / HALF_DAY / ON_LEAVE / HOLIDAY / WEEKLY_OFF), checkIn?, checkOut?, source (MANUAL; IMPORT later), leaveRequestId?, markedById, version | U(employee, date). Corrections audited with a reason |
| `Holiday` | date, name, appliesTo (ALL / STAFF / STUDENTS) | U(date, appliesTo); shared with the Phase 4 academic calendar |
| `SchoolSetting` (change) | `weeklyOff` (e.g. Sunday; optional 2nd/4th Saturday) | JSON, validated; drives working-day counting |

**Rules:** leave days = working days in the range (not weekly offs or staff holidays); approval deducts the balance and marks attendance `ON_LEAVE` in one transaction; approver ≠ requester; a paid type can't go below zero (L5); all writes audited with ids and counts (no reasons/remarks in audit rows — personal tier).

## 3. Owner decisions needed (L1–L12)

| # | Decision | Recommendation |
|---|---|---|
| **L1** | Leave year: academic session, or calendar year (Jan–Dec)? | **Academic session** — balances, holidays and reports line up with the school year already used everywhere (rule 8) |
| **L2** | Leave types: school-defined only, or a starter set? | **School-defined only** (no invented quotas); the form suggests common codes (CL, EL, ML, LOP) as placeholders, nothing saved |
| **L3** | Weekly off: which days? Configurable per school? | **Configurable setting** (default proposal: Sunday; 2nd and 4th Saturday optional) — never hard-coded |
| **L4** | Who approves? | **Any `leave.approve` holder except the requester**; the reporting manager (3A reports-to) is shown first in the queue but has no extra right. Multi-level approval: not in 3B |
| **L5** | Paid leave beyond the balance | **Refused** (apply as LOP instead); LOP is a school-defined unpaid type with no quota |
| **L6** | Cancellation | Requester cancels while PENDING; an approver cancels an APPROVED request **before its first day** (balance and attendance restored, audited); after that only a correction with reason |
| **L7** | Attendance marking | HR (`attendance.employee.mark`) marks a whole day on one phone screen (everyone PRESENT by default, tap exceptions); approved leave, holidays and weekly offs are pre-filled and locked; check-in/out times optional |
| **L8** | Corrections | Allowed with a reason, audited; **blocked once the month is locked** for payroll (3C adds the lock; 3B records it) |
| **L9** | Self-service | Staff see their **own** balances, requests and attendance. Needs `attendance.employee.read` at **SELF** for staff roles (catalog change → DB grants with approval, like KI-062); `leave.request` keeps ALL but means "own requests only" (service rule) |
| **L10** | Half-days | Per leave type (`allowHalfDay`), single-day requests only, 0.5 day |
| **L11** | Biometric / CSV import of attendance | **Out of 3B** (manual only); `source` column reserved |
| **L12** | Notifications (approval e-mails) | **Out of 3B** (notifications module later); the approval queue and the requester's list show status |

## 4. RBAC (proposed, for approval with L9)

| Capability | Super Admin | School Admin | Principal | Vice Principal | HR Manager | Staff roles | Parent / Student |
|---|---|---|---|---|---|---|---|
| Request own leave (`leave.request`) | ✓ | — | ✓ | ✓ | ✓ | ✓ | — |
| Approve / reject (`leave.approve`) | ✓ | — | ✓ | ✓ | ✓ | — | — |
| Leave types, holidays, opening balances (`employee.manage`) | ✓ | ✓ | — | — | ✓ | — | — |
| Mark / correct attendance (`attendance.employee.mark`) | ✓ | — | — | — | ✓ | — | — |
| All staff attendance (`attendance.employee.read` ALL) | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| Own attendance (`attendance.employee.read` SELF) | — | — | — | — | — | ✓ (new) | — |

## 5. Milestones

| Milestone | Content | Gate |
|---|---|---|
| **3B-M1** | Schema + migration `--create-only` (incl. the overlap exclusion constraint and CHECKs), static guard test | Owner approval of the SQL, then development, then Test |
| **3B-M2** | Leave types, holidays, weekly-off setting, opening balances | Unit + integration |
| **3B-M3** | Leave requests, approval queue, cancellation, balances (transactional), self-service | Integration incl. concurrency (double approval, overlapping requests) |
| **3B-M4** | Daily attendance marking (mobile), corrections, monthly register, self view | Integration + browser at 360 px |
| **3B-M5** | Monthly summary per employee (paid / LOP / half days) for 3C; reports / CSV | — |
| **3B-M6** | Verification on Test, browser review, security review, closure report | Owner sign-off |

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Double deduction under concurrent approval | Request and balance rows locked in one transaction; version checks; integration concurrency test |
| R2 | Overlapping leave | Database exclusion constraint + service check |
| R3 | Working-day arithmetic errors (holidays, weekly offs, half-days) | Pure, unit-tested calculator; Decimal, never floats |
| R4 | Personal data in reasons/remarks | Personal tier; never in audit rows or exports |
| R5 | Attendance edited after payroll | Month lock recorded in 3B, enforced from 3C |
| R6 | Free-tier load from daily marking | One batched transaction per day per screen |
