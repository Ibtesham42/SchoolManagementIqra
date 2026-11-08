---
name: payroll-management
description: Use when working on salary components, salary structures, employee salary assignment, monthly payroll runs, attendance/leave-based deductions, advances, bonus/arrears, salary slips, salary payments or payroll reports.
---

# Payroll management

## Responsibilities
Accurate monthly salaries with maker-checker approval, strict confidentiality and immutable history.

## Calculation (pure, `src/modules/payroll/payroll-calc.ts`)
Inputs: EmployeeSalary effective for the month, structure components, month working days (calendar minus holidays per policy), attendance (present, half-days, unpaid leave), advance recovery schedule, bonus, arrears.
- `paidDays = workingDays − LOP days` (half-day = 0.5; paid leave not LOP).
- Earnings: FIXED amount or PERCENT_OF_BASIC; prorated by `paidDays / workingDays` when the component is marked prorated.
- Deductions: configured components + advance recovery installment.
- `net = gross + bonus + arrears − deductions`; never negative (cap recovery, carry the remainder forward).
- All math in `decimal.js`, half-up to 2 dp per component.

## Run workflow (`PayrollRun.status`)
DRAFT → **prepare** (`payroll.prepare`: compute slips in one transaction, snapshot earnings/deductions JSON) → **approve** (`payroll.approve`, approver ≠ preparer, enforced) → **pay** (`payroll.pay`: record SalaryPayment with bank reference) → LOCKED.
Re-prepare is allowed only before approval. After approval, changes require "reopen" by Principal/Super Admin with a reason (audited).

## Rules
- Salary amounts are visible only with `payroll.read`; teachers see only their own slips (`salary.self.read`, SELF scope).
- Changing an employee's salary creates a new EmployeeSalary row with `effectiveFrom` and approval; past rows are never edited. The system never changes salaries automatically.
- Slip PDF renders from the snapshot, so later structure edits don't change past slips.
- Every step writes AuditLog; payroll exports require `payroll.read` + `export.run`.

## Tests
LOP & half-day proration, mid-month joiner, advance recovery capping, bonus/arrears, approver ≠ preparer, self-only slip access, snapshot immutability.
