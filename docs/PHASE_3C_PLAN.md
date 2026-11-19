# Phase 3C — Payroll: assessment and implementation plan

**Status: decisions P1–P16 and Q APPROVED as recommended (owner, 2026-11-19).** 3C-M1 (schema + migration `20261120000000_phase3c_payroll`, generated offline) **SQL approved and applied to development** 2026-11-19 (Test pending KI-059); the pure calculator (part of 3C-M3, `src/modules/payroll/payroll-calc.ts`) built and unit-tested 2026-11-19; 3C-M2 part 1 (salary components and structures, screens) built 2026-11-19; 3C-M2 … M6 (salaries, runs, approval, adjustments, payments, PAN / bank, slip PDF, register CSV) built 2026-11-19 — integration suites written, not run (KI-059); remaining: KI-089 (verifiable slip copies), 3C-M7 verification on Test; nothing is applied to any database until the owner approves the SQL, and building 3C-M2 onwards waits for 3B-M6 on Test. Phase 3 split (PHASE_3_PLAN.md §1.3 B6): 3A HR core (done; M6 verification pending KI-059) · 3B attendance & leave (M1–M5 built; M6 verification blocked on KI-059 / KI-073) · **3C payroll (this plan)**.

3C should start building only after 3B-M6 has run on Test: payroll depends on attendance and leave behaving correctly against a real database.

## 1. Starting point (verified from code)

- **Permissions already in the catalog (no catalog change proposed):** `payroll.read` (Principal, Accountant, HR Manager), `payroll.prepare` (Accountant, HR Manager), `payroll.approve` (Principal), `payroll.pay` (Accountant), `salary.structure.manage` (HR Manager), `salary.self.read` (SELF only — Teacher, Class Teacher, Accountant, HR Manager, Admission Officer, Transport Manager, Librarian), `employee.sensitive.read` (HR Manager; reserved for PAN / bank — PHASE_3_PLAN H5), `export.run`. Super Admin holds all.
- **Hand-off from 3B (M5):** `payrollMonthSummary` per employee and month gives `monthWorkingDays`, `offRollsDays`, `workingDays`, paid / unpaid leave, absent, manual half days, unmarked days, `lopDays` and `complete`. `AttendancePeriodLock(month)` exists; nothing writes it yet. Its writer **must take the leave-calendar lock first** (leave.tx.ts).
- **Infrastructure ready:** `lib/sequence` (row-locked counters), `lib/crypto` (AES-256-GCM + HMAC, key versions), `lib/pdf` (`@react-pdf/renderer` 4.9.0, letterhead) and `GeneratedDocument` (verification code hash, `SALARY_SLIP` type already in the enum), `lib/csv` (formula-safe), `decimal.js`, audit.
- **Planned models (DATABASE_SCHEMA §7):** SalaryComponent, SalaryStructure, EmployeeSalary, PayrollRun, Payroll (slip), SalaryAdvance, SalaryPayment. None exist yet; the proposal below refines them.
- **Rules that already apply:** money is `Decimal(12,2)` / `decimal.js`, never floats (CLAUDE.md rule 7); payroll run + approval in transactions (rule 3); slip numbers only from `lib/sequence` (rule 4); salary visible only with `payroll.read` or own slip (rule 10); maker-checker approval (skill); no invented school facts (rule 13). No statutory rates are seeded.

## 2. Proposed design (summary)

| Model | Fields (proposed) | Notes |
|---|---|---|
| `SalaryComponent` | code, name, kind (EARNING / DEDUCTION), calc (FIXED / PERCENT_OF_BASIC), prorated (bool), isActive, version | School-defined master data, deactivate only (like leave types). **Nothing seeded** (P1, P2) |
| `SalaryStructure` + `SalaryStructureItem` | structure: name, isActive, version · item: structureId, componentId, value Decimal(12,2) (amount or percent), sortOrder | A template, e.g. "Teaching — PGT". Child table instead of JSON (typed, FK to components) |
| `EmployeeSalary` | employeeId, structureId, basic Decimal(12,2), effectiveFrom (date, first of a month), status (PROPOSED / APPROVED / REJECTED), proposedById, approvedById?, approvedAt?, version | Never edited after approval: a change is a new row (P7). No overlapping approved rows per employee (service under the employee row lock; same decision as 3B-M1 — no `btree_gist`) |
| `PayrollRun` | month (date, first day), status (DRAFT → PREPARED → APPROVED → PAID), dayBasis snapshot, totals (gross, deductions, net), preparedById?, preparedAt?, approvedById?, approvedAt?, reopenedCount, version | U(month). Approval locks the attendance month (P5) |
| `PayrollSlip` | runId, employeeId, slipNo (sequence), salary snapshot (structure name, basic, items JSON), dayBasis, monthDays, offRollsDays, lopDays, paidDays, earnings JSON, deductions JSON, adjustments JSON, gross, totalDeductions, net, version | U(runId, employeeId), U(slipNo). **Snapshot** — later structure edits never change it (skill). Slip numbers assigned at approval so a re-prepare doesn't burn numbers (P11) |
| `PayrollAdjustment` | slipId, kind (BONUS / ARREARS / OTHER_EARNING / OTHER_DEDUCTION), amount, note (personal tier), createdById | Only while the run is DRAFT / PREPARED (P10) |
| `SalaryAdvance` (if P9 = in) | employeeId, amount, monthlyRecovery, startMonth, outstanding, status, approvedById | Recovery capped so net never goes negative; the remainder is carried forward |
| `SalaryPayment` | slipId, amount, method (BANK_TRANSFER / CHEQUE / CASH / UPI), reference?, paidOn (date), paidById | U(method, reference) partial where reference not null. Sum ≤ net |
| `Employee` (change, if P8 = collect) | panEnc, panHmac, bankAccountEnc, bankAccountHmac, bankIfsc, bankAccountName, version | Encrypted with `lib/crypto`; HMAC for dedupe; shown masked; only `employee.sensitive.read` |
| `SchoolSetting` (change) | `payrollDayBasis` (WORKING_DAYS / CALENDAR_DAYS; **no default** — P3), slip number format | Payroll refuses to prepare until the basis is set |

**Calculation (pure, `src/modules/payroll/payroll-calc.ts`, unit tested):**
- `monthDays` = the month's working days (WORKING_DAYS) or its calendar days (CALENDAR_DAYS). It is **never the employee's own count** (3B audit M5-M1).
- `paidDays = monthDays − offRollsDays′ − lopDays`, where `offRollsDays′` uses the same basis.
- Each earning: FIXED amount or a percentage of basic. When `prorated`, it is multiplied by `paidDays / monthDays`, then rounded half-up to 2 dp **per component**.
- Deductions: the configured components, then advance recovery.
- `net = gross + adjustments − deductions`, never negative (recovery capped first).

## 3. Owner decisions needed (P1–P16)

| # | Decision | Recommendation |
|---|---|---|
| **P1** | Salary components: school-defined only, or a starter set? | **School-defined only** (rule 13). The form suggests common names (Basic, DA, HRA, Transport allowance, PF, Professional tax) as placeholders; nothing is saved |
| **P2** | Statutory deductions (PF, ESI, professional tax, TDS / income tax) | **No automatic statutory calculation in 3C.** The school sets them up as ordinary FIXED / PERCENT_OF_BASIC deduction components. Rates, slabs and ceilings change by law and state; computing them wrongly is worse than not computing them. Revisit after go-live |
| **P3** | Proration basis: working days or calendar days? | **School setting, no default** — the school chooses before the first run (both are common). Payroll refuses to prepare until it is set |
| **P4** | Incomplete attendance (3B-M5 `complete = false`) | **Refuse to prepare** while any employee in the run has unmarked working days. HR marks them first (L7/L8). No "treat as present" shortcut |
| **P5** | Attendance month lock | **Locked at approval** (`AttendancePeriodLock`, calendar lock first). From then on attendance and leave changes for that month are refused (L8); reopening the run unlocks it |
| **P6** | Who prepares, approves, pays | As in the catalog: prepare = Accountant / HR Manager; approve = **Principal** (and Super Admin); pay = Accountant. **Approver ≠ preparer** — Super Admin included. An unlinked non–Super Admin can't approve (KI-069 principle) |
| **P7** | Salary assignment changes | **Maker-checker:** HR proposes (`salary.structure.manage`), a `payroll.approve` holder approves; approver ≠ proposer; nobody proposes or approves their own salary. Past rows are never edited |
| **P8** | PAN and bank details | **Collect in 3C, optional**: PAN, bank account, IFSC, account name. Encrypted + HMAC, masked, `employee.sensitive.read` only (HR Manager, Super Admin); never in audit rows, logs or ordinary exports |
| **P9** | Salary advances | **Defer to after 3C** (keeps the first payroll small). Until then a one-off recovery is entered as an OTHER_DEDUCTION adjustment with a note |
| **P10** | Bonus, arrears, one-off items | Per-slip **adjustments** with a note, only before approval; audited (amount and kind, never the note) |
| **P11** | Slip numbers | `lib/sequence`, assigned **at approval** in the approval transaction. Format a setting, e.g. `SLIP-{YYYY}{MM}-{SEQ:4}` (no invented format: the school confirms) |
| **P12** | Slip PDF and self-service | PDF rendered **from the snapshot**, letterhead, verification code (`GeneratedDocument`, type SALARY_SLIP). Staff see **their own** slips (`salary.self.read` SELF) once the run is **APPROVED** |
| **P13** | Recording payment / bank file | Record payments per slip or as one bulk payment (method, reference, date). **No bank upload file in 3C.** A "bank advice" CSV with full account numbers would need `employee.sensitive.read` + `export.run`; propose it later if the school's bank needs it |
| **P14** | Rounding | Half-up to 2 dp per component (skill). Optional "round net to the rupee" — **off** unless the school asks |
| **P15** | Mid-month joiners and leavers | Prorated on the month denominator (P3) minus the days off the rolls; covered by 3B-M5's `offRollsDays` |
| **P16** | Reopening an approved run | Principal or Super Admin, with a reason, **before any payment is recorded**: slips go back to PREPARED (slip numbers kept) and the attendance month unlocks. After payment, corrections go into the next month as arrears / deductions |

## 4. RBAC (no catalog change proposed)

| Capability | Super Admin | Principal | Accountant | HR Manager | Staff roles | Others |
|---|---|---|---|---|---|---|
| Components, structures (`salary.structure.manage`) | ✓ | — | — | ✓ | — | — |
| Propose salary (`salary.structure.manage`) / approve (`payroll.approve`) | ✓ / ✓ | — / ✓ | — | ✓ / — | — | — |
| See salaries and runs (`payroll.read`) | ✓ | ✓ | ✓ | ✓ | — | — |
| Prepare / re-prepare a run (`payroll.prepare`) | ✓ | — | ✓ | ✓ | — | — |
| Approve / reopen (`payroll.approve`) | ✓ | ✓ | — | — | — | — |
| Record payments (`payroll.pay`) | ✓ | — | ✓ | — | — | — |
| Own slips (`salary.self.read` SELF) | — | — | ✓ | ✓ | ✓ (Teacher, Class Teacher, Admission Officer, Transport Manager, Librarian) | — (Principal, Vice Principal, School Admin: see Q) |
| PAN / bank (`employee.sensitive.read`) | ✓ | — | — | ✓ | — | — |
| Payroll exports (`payroll.read` + `export.run`) | ✓ | — | ✓ | ✓ | — | — |

**Q (part of P12):** Principal, Vice Principal and School Admin have no `salary.self.read`, so they couldn't see their own slips. Recommendation: add `salary.self.read` (SELF) to those three roles — a catalog change (+3 grants), synced to the databases with approval like KI-062 / KI-073.

## 5. Milestones

| Milestone | Content | Gate |
|---|---|---|
| **3C-M0** | Owner decisions P1–P16 (+ Q); 3B-M6 verified on Test | Owner |
| **3C-M1** | Schema + migration `--create-only` (models above, CHECKs: amounts ≥ 0, percent 0–100, month = first day, status transitions by service), static guard test, `db:check` support | Owner approval of the SQL, then development, then Test |
| **3C-M2** | Components, structures, salary proposals and approval; PAN / bank (encrypted, masked) | Unit + integration (maker-checker, no self-approval, no overlap) |
| **3C-M3** | Pure calculator + prepare / re-prepare run (one transaction per run, snapshot, adjustments) | Unit (proration, LOP, half days, joiner/leaver, rounding, never-negative) + integration (concurrent prepares, incomplete attendance refused) |
| **3C-M4** | Approve (slip numbers, attendance month lock, approver ≠ preparer), reopen | Integration incl. concurrency (approve vs attendance correction, approve vs leave approval) |
| **3C-M5** | Slip PDF + verification, My salary slips, payments | Integration + PDF render tests |
| **3C-M6** | Reports: run register, component totals, CSV (formula-safe, audited) | — |
| **3C-M7** | Verification on Test, browser review at 360 / 768 / 1280 px, security review, closure report | Owner sign-off |

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Wrong salary from float or rounding errors | `decimal.js` only, half-up per component, golden-value unit tests |
| R2 | Overpaying joiners / leavers | Month denominator (P3 / P15), tests from 3B-M5 |
| R3 | Attendance edited after payroll | Month lock at approval (P5), calendar lock first; L8 refusals already built |
| R4 | One person prepares and approves, or approves their own salary | Approver ≠ preparer and ≠ subject, enforced in services, Super Admin included; integration tests |
| R5 | Salary / bank data leaking | `payroll.read` / `employee.sensitive.read` gates, explicit selects, encrypted PAN / bank, masked display, nothing in audit rows or logs, exports gated and audited |
| R6 | Past slips changing after a structure edit | Snapshot on the slip; PDF renders only from the snapshot |
| R7 | Statutory miscalculation | Out of scope (P2): school-configured components only |
| R8 | Free-tier load at month end | One transaction per run; staff counts are small (hundreds); slips rendered on demand, not stored in bulk unless downloaded |

## 7. Documents to update when 3C starts

DATABASE_SCHEMA §7 and DATABASE_RELATIONSHIPS (M1), ADR row in SYSTEM_ARCHITECTURE §2 (payroll snapshot + month lock), RBAC_MATRIX / AUTHENTICATION_AND_RBAC (if Q is approved), API_DOCUMENTATION (exports, slip PDF route), SECURITY (sensitive fields), DEVELOPMENT_ROADMAP, KNOWN_ISSUES, DEVELOPMENT_PROGRESS, CHANGELOG.
