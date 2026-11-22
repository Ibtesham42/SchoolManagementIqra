# Phase 5 — Fee and finance management: assessment and implementation plan

**Status: decisions FC1–FC26 APPROVED as recommended (owner, 2026-11-20).** Catalog change FC6 / FC13 made and synced to development and Test (86 / 13 / 312). 5A-M1 done: migration `20261124000000` applied to development and Test 2026-11-20. 5A-M2 (setup services and screens) built 2026-11-20. 5A-M3 (concessions, charges) built 2026-11-20. 5A-M4 (invoice generation, cancel, re-pricing, ledger) built 2026-11-20; migration `20261125000000` applied to development and Test. 5B-M1 (counter collection) built 2026-11-21. 5B-M3 (receipts, cancellation) built 2026-11-22. 5B-M2 (receipt PDF) built 2026-11-22. 5C-M1 (reports + CSV) built 2026-11-22. 5C-M2 (reconciliation) built 2026-11-22. Next: 5C-M3 (opening-balance import); 5B-M4 (verification on Test — KI-059, browser review). The §9 questions for the school are still open (they shape setup data and screens, not the schema). Like Phases 3 and 4, Phase 5 is split (FC1): **5A** fee setup and billing · **5B** counter collection, receipts and cancellation · **5C** reports, reconciliation and opening-balance import. Online payments are designed here but deferred to Phase 6 (FC16).

Drafted by the architect agent (read-only) from the code; key claims spot-checked (no user ↔ student link, `lib/money.ts` missing, `students.policy` refuses CHILDREN / SELF).

**Open items carried in (they don't block planning, but they block "complete"):**
- KI-059: database verification for Phases 1, 2a, 2B, 3A–3C and 4 is still pending. The integration runner still can't read `TEST_TARGET_*` from `.env`.
- Fees bill **enrollments** (Phase 2B) and use promotion's next-session enrollments (4C). So the 5A-M1 migration should go to Test only after 2B (and the 4C promotion suites) pass there.
- Migrations are created with `--create-only`, the SQL is reviewed, and the owner approves before it is applied to development and then Test.

## 1. Starting point (verified from code)

- **Permissions already in the catalog** (`src/lib/rbac/catalog.ts:67-74`): `fee.structure.manage`, `fee.read`, `fee.collect`, `fee.concession.manage`, `fee.refund`, `fee.report`, `fee.pay.online`.
  - **Accountant** holds all of them except `fee.pay.online` (line 246). It also holds `student.read` (ALL) and `export.run`.
  - **School Admin** has `fee.read` (line 203).
  - **Principal and Vice Principal** have `fee.read` through `READ_ACADEMIC` (line 141) plus `fee.report` (lines 223, 237).
  - **Parent** has `fee.read` and `fee.pay.online` at **CHILDREN** (lines 309-310). **Student** has `fee.read` at **SELF** (line 319).
  - Nobody except Super Admin holds `import.run` together with any fee permission.
  - The databases hold 85 permissions / 309 grants (KI-073, resolved 2026-11-20).
- **There is no user ↔ guardian or user ↔ student link yet.**
  - `User.studentId` and `User.guardianId` are plain columns. They become foreign keys only in Phase 6 (`prisma/schema.prisma:43-47`).
  - `students.policy.ts:12-20` refuses CHILDREN and SELF with `ForbiddenError`. Fees must do the same.
- **Sequences:** `nextSequence` and `nextSequenceBlock` are row-locked and roll back with the caller's transaction, so they are gap-free on failure (`src/lib/sequence.ts:8-31`).
  - `formatSequence` and `sequenceKey` support `{CODE} {YYYY} {YY} {SESSION} {CLASS} {SEQ:n}` (line 40).
  - Formats live in `SchoolSetting.idFormats` (JSON), so adding fee formats needs no migration.
  - Payroll reads its slip format with `readSlipFormatTx` (`src/modules/payroll/runs.service.ts:39-45`). That function **reads `schoolSetting` directly from the payroll module**, which breaks the module boundary. Fees should not copy it: add `readFeeSettingsTx` to `settings.service` instead, as `readAdmissionSettings` (`settings.service.ts:220`) does.
- **Closest analogue: payroll.**
  - Money uses a `decimal.js` clone with half-up rounding (`payroll-calc.ts:16-18`).
  - Writers are serialized by one advisory lock (`payroll.tx.ts:9-12`).
  - Slip numbers are assigned as a sequence block at approval (`runs.service.ts:293-305`).
  - Payment references are unique per method, and amounts are never audited (`slips.service.ts:111-135`).
  - Slip PDFs are rendered on demand from a snapshot via `documents/templates/*` and `renderPdf`, with no verification code (KI-089).
  - The CSV export route follows a fixed pattern: same-origin POST → session → `RULES.export` → service → `private, no-store` (`api/v1/payroll/runs/[id]/export/route.ts`).
- **Other infrastructure that is ready:**
  - `GeneratedDocumentType.RECEIPT` exists (`schema.prisma:420`). `documents.issueDocument` requires `document.generate`, which the Accountant does not hold (`documents.service.ts:64`). This is the same gap as KI-089 / KI-090.
  - `lib/csv` (formula-safe) and `lib/import/tabular.ts` (CSV/XLSX, 512 KB / 500 rows, zip-bomb guard) are available. Marks import used the **domain permission, not `import.run`** (`marks-import.service.ts:16,30`), which is the precedent for FC19.
  - The `exceljs` and `papaparse` dependencies are already approved.
- **Gaps against CLAUDE.md:**
  - **`src/lib/money.ts` does not exist**, although CLAUDE.md lists it.
  - **There is no soft-delete Prisma extension** in `src/lib/db.ts`; services filter `deletedAt` explicitly.
  - Enrollment is the session anchor: `StudentEnrollment` has `@@unique([id, academicSessionId])` (`schema.prisma:821`), which is the target for a composite FK. Its statuses are ACTIVE, PROMOTED, DETAINED and LEFT, and it carries `enrolledOn` / `leftOn`.
  - Siblings are detectable only through a shared `Guardian` (`StudentGuardian`).
- **The earlier draft models** (DATABASE_SCHEMA §8) are a starting point. The changes proposed below are:
  - installments become a typed table instead of `installmentPlan` JSON;
  - invoices reference the **enrollment**;
  - the receipt is merged into the payment row;
  - allocations are made at invoice-item level;
  - a per-student charges table is added (manual charges, and the transport hook);
  - `PaymentGatewayEvent` is deferred to Phase 6.

## 2. Proposed design (summary)

New module **`src/modules/fees/`**. Allowed dependencies: settings, students (reads through exported `*.tx.ts` helpers, never their tables), academic (classes and sessions through its service) and documents (template + branding).

Dependency direction:
- transport (Phase 7) → fees, never the reverse;
- certificates (Phase 7) → fees (`outstandingForStudent`);
- portal (Phase 6) → fees.

| Model | Fields (proposed) | Notes |
|---|---|---|
| `FeeCategory` | code, name, kind (REGULAR / ONE_TIME / TRANSPORT / LATE_FEE / OPENING_BALANCE / OTHER), appliesTo (ALL / NEW_ADMISSION / EXISTING), isActive, version | School-defined; deactivate only. System kinds TRANSPORT / LATE_FEE / OPENING_BALANCE are created by the service on first use, never seeded with amounts (FC2) |
| `FeeInstallment` | academicSessionId, name ("April", "Term 1"), dueDate (date), sortOrder | U(session, name). Replaces `installmentPlan` JSON (FC3). Due date inside the session (service) |
| `FeeStructure` + `FeeStructureItem` | structure: academicSessionId, classId, name, isActive, version · item: structureId, categoryId, installmentId, amount Decimal(12,2) | U(session, class) for the active structure; U(structure, category, installment). Frozen once any invoice uses it: edits create a new version (FC5) |
| `FeeConcession` | code, name, kind (CONCESSION / SCHOLARSHIP / DISCOUNT / WAIVER), calc (PERCENT / FIXED), value, categoryIds (child table `FeeConcessionCategory`), isActive | Template. Percent 0–100 CHECK |
| `StudentConcession` | enrollmentId (+ session, composite FK), concessionId, status (PROPOSED / APPROVED / REJECTED / REVOKED), reason (personal tier, not audited), proposedById, decidedById?, decidedAt?, version | U(enrollment, concession) where not REVOKED/REJECTED. Maker-checker (FC6) |
| `LateFeeRule` | academicSessionId, graceDays, calc (FLAT / PER_DAY / PERCENT), value, cap?, isActive | One active per session (FC7) |
| `StudentFeeCharge` | enrollmentId (+ session), installmentId, categoryId, amount, source (MANUAL / TRANSPORT), sourceRef?, note, createdById, invoicedAt? | Per-student extras picked up by generation. **The transport hook** (FC18) |
| `FeeInvoice` | invoiceNo (sequence at issue), enrollmentId + academicSessionId (composite FK), installmentId, dueDate (snapshot), subtotal, concessionTotal, lateFee, total, paidAmount, status (ISSUED / PARTIAL / PAID / WAIVED / CANCELLED), cancelReason?, cancelledById?, deletedAt (= cancelled), version | **Partial** U(enrollment, installment) WHERE deleted_at IS NULL (idempotent re-runs, re-issue after cancel). CHECKs: total = subtotal − concessionTotal + lateFee, 0 ≤ paid ≤ total, status ⇔ amounts. IX(status, dueDate), IX(session, installment) |
| `FeeInvoiceItem` | invoiceId, categoryId, description (snapshot), amount, concessionAmount, paidAmount, kind (STRUCTURE / CHARGE / LATE_FEE / OPENING_BALANCE), sortOrder | CHECK 0 ≤ concession ≤ amount, 0 ≤ paid ≤ amount − concession |
| `FeePayment` (= receipt) | receiptNo (sequence), studentId, amount, method (CASH / UPI / BANK_TRANSFER / CHEQUE / CARD), transactionRef? (normalized), instrumentDate?, bankName?, paidOn (date), idempotencyKey, collectedById, receiptSnapshot JSON, status (SUCCESS / CANCELLED), cancelledAt?, cancelledById?, cancelReason?, printCount, version | U(receiptNo), U(idempotencyKey), **partial** U(method, transactionRef) WHERE ref IS NOT NULL AND status = 'SUCCESS'. CHECK amount > 0; non-cash ⇒ ref. The receipt is merged into the payment (one row per receipt); Phase 6 adds PENDING, `receiptNo` nullable until success, and gateway columns |
| `FeePaymentAllocation` | paymentId, invoiceItemId, invoiceId (denormalized), amount, reversedAt? | PK(payment, item). Σ allocations = payment amount (service + reconciliation) |
| `SchoolSetting.idFormats` (JSON, no migration) | `feeReceipt`, `feeInvoice` | Required before the first issue or collection (FC12) |

**Pure modules (unit tested):**
- `src/lib/money.ts` (new): a half-up `Decimal` clone, `toMoney`, `sumMoney` and `amountInWordsIndian` (lakh / crore, "Rupees … only").
- `fees/fee-calc.ts`: per-line concession (percent before fixed, never below zero, half-up per line) → invoice totals. Late fee as of a school-local date (grace, flat / per-day / percent, cap).
- `fees/allocation.ts`: oldest-due first; within an invoice in item order, late fee last; exact cent splitting; refuses overpayment.
- `fees/fee-rules.ts`: which installments and items apply to an enrollment (joiner / leaver / new admission).

**Locks:** `lockFeeSetup(tx)` is an advisory lock, like `lockPayroll`. It is taken first by structure, concession and late-fee writes, by generation and by invoice cancellation. Collection and receipt cancellation take an advisory lock per student, then the open invoices `FOR UPDATE ORDER BY id`. The sequence comes **last**, because its row lock serializes every collector. Full lock order: setup → student → invoice rows → sequence.

## 3. Owner decisions needed (FC1–FC26)

| # | Decision | Recommendation |
|---|---|---|
| **FC1** | Split Phase 5? | **Yes: 5A / 5B / 5C**, each with its own review, verification and closure |
| **FC2** | Fee categories: school-defined or a starter list? | **School-defined only** (rule 13). The form suggests common names (Tuition, Admission, Annual, Exam, Lab) as placeholders; nothing is saved |
| **FC3** | Fee schedule | **A school-defined installment table per session** (monthly, quarterly or terms — the school decides). The structure is per **session × class**, with an amount per category per installment. Section-level differences are out of scope |
| **FC4** | Who is billed: joiners, leavers, new admissions | Joiners get the installments **due on or after `enrolledOn`** plus NEW_ADMISSION items. Leavers get no invoices after `leftOn`, and their unpaid invoices stay as dues. Re-billing PROMOTED / DETAINED enrollments in the old session: never |
| **FC5** | Generation and changes after issue | **Preview (no writes) → issue**, one transaction per class; re-running skips existing invoices (partial unique). Numbers are assigned at issue. Structure edits never change issued invoices. An invoice **without payments** may be cancelled (reason, soft delete) and re-issued; one with payments can only be corrected through a concession / waiver |
| **FC6** | Concessions and scholarships | **Maker-checker.** The Accountant proposes (`fee.concession.manage`); a **new `fee.concession.approve`** holder (Principal) approves; approver ≠ proposer, Super Admin included. **No automatic sibling discount**; the screen shows siblings found through shared guardians, and the school applies a sibling concession manually. An approval applies to invoices issued afterwards, plus a "re-price" of the student's **unpaid** open invoices in the same transaction |
| **FC7** | Late fee | One rule per session (or none). **Computed live** from the school-local date and **frozen onto the invoice as a LATE_FEE item in the collection transaction**. The collector may waive it only with `fee.concession.manage` and a reason (audited without the reason). No nightly job |
| **FC8** | Allocation | **Oldest due first.** Within an invoice, items in order with the late fee last. The collector may tick which invoices to pay, but cannot split a single item arbitrarily |
| **FC9** | Partial / over-payment | Partial: **yes**. Overpayment: **refused**. An advance or credit balance is deferred (KI to open) |
| **FC10** | Methods and references | CASH, UPI, BANK_TRANSFER, CHEQUE, CARD (POS). Every non-cash method needs a reference, trimmed and upper-cased, **unique per method among successful payments**, so a cancelled payment's reference can be reused |
| **FC11** | Cheques | Receipt issued on collection (status SUCCESS). A **dishonoured** cheque = receipt cancellation with reason "dishonoured"; an optional bounce charge is a MANUAL `StudentFeeCharge`. No PENDING-until-cleared state in Phase 5 |
| **FC12** | Receipt / invoice numbers | `lib/sequence`, inside the transaction, assigned **only on success** (gap-free; cancelled receipts keep their numbers). Formats are **settings with no default**: collection and issue refuse until they are set. The form suggests e.g. `RCT/{SESSION}/{SEQ:5}`; the school confirms. There is no separate payment number |
| **FC13** | Cancellation and refunds | **Cancel only.** Void with a reason; allocations are reversed; the number is kept; the PDF is stamped "CANCELLED". `fee.refund`; **canceller ≠ collector**; add `fee.refund` to **Principal** so a one-accountant school has a second person. Refunding a valid payment (e.g. a leaver) is **deferred** (KI) |
| **FC14** | Receipt PDF | Rendered **on demand from `receiptSnapshot`** (never from current structures), letterhead, amount in words, "DUPLICATE" from the second print (`printCount`). **The verification code is deferred** and solved together with KI-089 / KI-090 by one documents change (a module-authorized issuing path) |
| **FC15** | Double submit | A random idempotency key is placed in the counter form when the server renders it, with U(idempotencyKey). A replay with the same key, student and amount returns the existing receipt; anything else is a conflict. The SubmitButton pending state is cosmetic only |
| **FC16** | Online payments | **Defer to Phase 6** (the payers, parents, have no portal yet; Razorpay needs a merchant account and charges a fee per transaction — owner decision). Phase 5 records the design (ADR): `lib/payments` interface with a `none` driver, server-computed amount, PENDING payment, verify plus webhook on the raw body, `PaymentGatewayEvent` U(gateway, eventId), whichever arrives first wins under the student lock. `PAYMENT_GATEWAY` stays `none`. No stub routes or buttons (no placeholders) |
| **FC17** | Parent CHILDREN / Student SELF grants | **No catalog change.** `fees.policy` refuses CHILDREN / SELF with Forbidden (like `students.policy`), the Fees menu needs the ALL scope, and tests prove it. Phase 6 adds the guardian / student link and the scoped policy |
| **FC18** | Transport fees | Phase 7's transport service writes TRANSPORT `StudentFeeCharge` rows **through a fees service function**, and generation picks them up. Phase 5 uses the same table for MANUAL charges (hostel, activity) |
| **FC19** | Import | **Opening balances only** (previous dues from the old system, per student, as an OPENING_BALANCE invoice): template → upload (`lib/import/tabular`) → preview → confirm through the service. Permission: `fee.structure.manage` (marks-import precedent). No import of past payments |
| **FC20** | Reports | Outstanding by class / section / installment, defaulters (overdue days), collection by day / method / collector / category, concession register, cancelled-receipt register, reconciliation. CSV with `fee.report` + `export.run`, formula-safe and audited. **Defaulters include the primary guardian's name and phone** (needed to call); confirm |
| **FC21** | Accounting scope | **No** general ledger, expenses, GST or Tally export in Phase 5 (a CSV of receipts can be imported elsewhere). Revisit after go-live |
| **FC22** | Reminders | **Deferred** to Phase 6 / 10 (portal plus notifications; email cap 90 / day; no SMS) |
| **FC23** | Dues when a student leaves | The status-change screen **warns** with the outstanding amount, but does not block. Whether a transfer certificate needs "no dues" is decided with Phase 7 certificates |
| **FC24** | Rounding | Half-up to 2 dp per line (concession, late fee); totals are sums of rounded lines. "Round the invoice total to the rupee": **off** unless the school asks |
| **FC25** | Closed sessions | Generation only in PLANNED / ACTIVE sessions. **Collection is allowed against any session's open invoices** (arrears). The counter shows previous-session dues first |
| **FC26** | Day close / cash handover | Phase 5 gives a daily collection report per collector. A formal day close (locking a day's receipts) is **deferred** (KI) |

## 4. RBAC (proposed)

| Capability | Super Admin | School Admin | Principal | Vice Principal | Accountant | Parent / Student |
|---|---|---|---|---|---|---|
| Categories, installments, structures, late fee, generation, charges, opening-balance import (`fee.structure.manage`) | ✓ | — | — | — | ✓ | — |
| Propose concessions, waive late fee (`fee.concession.manage`) | ✓ | — | — | — | ✓ | — |
| Approve concessions (**new `fee.concession.approve`**) | ✓ | — | **✓ (new)** | — | — | — |
| Collect (`fee.collect`) | ✓ | — | — | — | ✓ | — |
| Cancel receipts (`fee.refund`, ≠ collector) | ✓ | — | **✓ (new)** | — | ✓ | — |
| Ledgers, invoices, receipts (`fee.read` ALL) | ✓ | ✓ | ✓ | ✓ | ✓ | CHILDREN / SELF: **refused until Phase 6** |
| Reports (`fee.report`), CSV (+ `export.run`) | ✓ | — | ✓ (view; no `export.run`) | ✓ (view) | ✓ | — |
| Online payment (`fee.pay.online`) | — | — | — | — | — | not used in Phase 5 |

- **Catalog change (FC6, FC13):** +1 permission and +3 grants: Super Admin gets the new permission automatically, Principal gets `fee.concession.approve` and `fee.refund`. Totals go **85 / 13 / 309 → 86 / 13 / 312**. This is synced to development and Test with approval, using the KI-062 / KI-073 procedure.
- `ALLOWED_SCOPES` is unchanged: CHILDREN / SELF stay offerable, but fees refuses them.
- Every new endpoint and action gets an RBAC test showing forbidden roles get 403 or the not-permitted screen.
- Escalate to `security-auditor` for payments, exports and cancellation.

## 5. Milestones

| Milestone | Content | Gate |
|---|---|---|
| **5-M0** | Owner decisions FC1–FC26 + the questions in §9; Phase 2B verified on Test (KI-059) | Owner |
| **5A-M1** | Schema + migration `20261124000000_phase5a_fees` (`--create-only`, offline diff): every model in §2, CHECKs, partial uniques with comments, composite enrollment FKs, static guard test, `db:check` support. Also `lib/money.ts` + `fee-calc.ts` + `allocation.ts` + `fee-rules.ts` (unit) | Owner approval of the SQL, then development, then Test |
| **5A-M2** | Categories, installments, structures (versioned, frozen once used), late-fee rule, fee number settings (`readFeeSettingsTx` in settings) | Unit + integration |
| **5A-M3** | Concessions: templates, propose / approve / reject / revoke (maker-checker), re-pricing of unpaid invoices; MANUAL charges | Integration (no self-approval, Super Admin included; concurrent approve vs generate) |
| **5A-M4** | Invoice generation: preview → issue per class (sequence block, one transaction per class, 30 s cap); cancel / re-issue; student fee ledger page | Integration (idempotent rerun, joiner / leaver, 1,000 synthetic students timed on Test) |
| **5B-M1** | Counter collection: search by name / admission no / student ID → dues across sessions → amount, method, reference → allocate → receipt number → audit (method, date and receipt number only, never the amount) | Integration (idempotency, duplicate reference, concurrent collectors on one student, over-payment refused) + browser at 360 px |
| **5B-M2** | Receipt PDF (`documents/templates/fee-receipt.tsx`, snapshot, amount in words, DUPLICATE / CANCELLED stamps), `GET /api/v1/fees/receipts/[id]/pdf` (rate-limited — new rule, cf. S-21) | PDF render tests |
| **5B-M3** | Receipt cancellation (reason, reversal, canceller ≠ collector), late-fee freeze and waiver | Integration |
| **5B-M4** | Verification on Test, security review, browser review at 360 / 768 / 1280 px | Owner sign-off |
| **5C-M1** | Reports + CSV exports (`POST /api/v1/fees/reports/[name]/export`, export-route pattern, ≤ 5,000 rows) | Integration (scope, redaction, formula safety, audit) |
| **5C-M2** | Reconciliation report + SQL invariants: Σ allocations = payment; item / invoice `paidAmount` = Σ live allocations; receipts by day / method = collection report; no gaps in issued numbers except cancelled ones | Integration over a simulated term |
| **5C-M3** | Opening-balance import (template route, preview, confirm through the service, idempotent by student + "opening" installment) | Integration |
| **5C-M4** | Verification on Test: a full fee term simulated, **reconciliation matches payments** (roadmap criterion), closure report | Owner sign-off |

**Planned file layout:**
- `src/modules/fees/`: `fee-calc.ts`, `allocation.ts`, `fee-rules.ts`, `fees.policy.ts`, `fees.tx.ts`, and service + schemas pairs for `setup`, `concessions`, `invoices`, `collection` and `reports`, plus `opening-balance-import.service.ts`.
- `src/modules/students/enrollment-reads.tx.ts` (reads only; the caller authorizes).
- Pages under `src/app/erp/fees/`: dashboard, setup, concessions, invoices, collect, `students/[id]`, `receipts/[id]` and reports.
- Visual specs come from `ui-ux-designer`: the counter screen (one column, large amount field, method chips, sticky "Collect ₹X") and the ledger as cards.
- Table-level details come from `database-engineer`.

## 6. Tests (required)

- **Unit:**
  - concession math (percent before fixed, floor at zero, multi-category);
  - late fee (grace boundary in the school time zone, per-day cap, percent);
  - allocation (oldest first, exact cents, late fee last, over-payment refused);
  - amount in words (0, 1, 1,00,000, 99,99,999.99);
  - joiner / leaver rules;
  - number formats.
- **Integration (real DB, Test branch):**
  - re-running generation is idempotent;
  - 20 concurrent collections give distinct, consecutive receipt numbers;
  - a rolled-back collection consumes no number;
  - the same idempotency key twice gives one payment;
  - a duplicate UPI reference is rejected, and is allowed again after cancellation;
  - partial then full payment moves PARTIAL → PAID;
  - cancellation reverses allocations and restores the balance;
  - canceller = collector is refused;
  - concession self-approval is refused;
  - a structure edit after issue does not change invoices or receipt PDFs;
  - collection against a CLOSED session's invoice works;
  - the reconciliation report is clean after a mixed simulated term;
  - RBAC table per role (Parent / Student refused, Teacher refused, Vice Principal read-only);
  - audit rows contain no amounts or reasons.
- **E2E:** counter collection and receipt download at 360 px, axe clean.

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Duplicate payment (double tap, retry, two counters) | Idempotency key unique + student advisory lock + reference uniqueness; concurrency tests |
| R2 | Float or rounding errors | `lib/money` only, half-up per line, CHECKs on totals, golden tests |
| R3 | Receipts changing after the fact | Snapshot on the payment; cancellation only; numbers never reused; PDF only from the snapshot |
| R4 | Concession fraud (an accountant discounting a relative) | Maker-checker (FC6); concession register report; the relationship can't be detected until Phase 6 links guardians (documented) |
| R5 | Cash skimming through cancellation | Canceller ≠ collector, reason required, cancelled-receipt register, per-collector daily report |
| R6 | Free-tier load at generation / month end | One transaction per class, `createMany`, sequence block, measured on Test; reports as aggregate SQL on indexed columns, paginated |
| R7 | Sequence row as a hotspot | Sequence taken last, short transactions; acceptable at one-school scale |
| R8 | Scope creep (gateway, ledger, reminders, refunds) | FC16, FC21, FC22, FC13 keep them out explicitly |
| R9 | Module-boundary drift (direct reads of `schoolSetting` / `studentEnrollment`, already present in payroll and academic) | Fees reads only through settings / students helpers; `check:deps`; the existing drift is noted, not fixed in Phase 5 |
| R10 | Portal scopes silently widening | CHILDREN / SELF refused in `fees.policy` + tests (S-08 principle) |

**KIs to open:**
- advance / credit balance (FC9);
- refund of valid payments (FC13);
- receipt verification code (merged with KI-089 / KI-090);
- formal day close (FC26);
- online payments (FC16, Phase 6).

## 8. Completion criteria

1. The 5A / 5B / 5C integration suites are green on Neon Test.
2. A simulated term reconciles: payments = allocations = invoice paid amounts, and collection reports match receipts.
3. E2E counter flow passes at 360 / 768 / 1280 px, axe clean.
4. The RBAC matrix is regenerated, with the catalog sync applied to development and Test (with approval).
5. Security review is done (payments, exports, cancellation).
6. `lint`, `typecheck`, `check:deps` and `test` all pass; CI is green.
7. Docs are updated:
   - DATABASE_SCHEMA §8 and DATABASE_RELATIONSHIPS;
   - ADR rows: (a) installment table and enrollment-based invoices, (b) receipt merged into the payment with a snapshot, (c) gateway deferred with the recorded design, (d) the `lib/money` module;
   - RBAC_MATRIX and AUTHENTICATION_AND_RBAC;
   - API_DOCUMENTATION;
   - UI_UX_GUIDELINES (counter screen);
   - DEVELOPMENT_ROADMAP §7 (online payments moved to Phase 6), ENVIRONMENT_VARIABLES (note), KNOWN_ISSUES, DEVELOPMENT_PROGRESS, CHANGELOG.

## 9. Questions for the school (missing requirements, not decisions)

1. The actual fee heads and installment pattern, and whether amounts differ by stream (Class 11 Science / Commerce are separate classes, so that works).
2. The current receipt number format, and whether numbering resets per academic session or per financial year (April–March).
3. How many people collect fees, and whether the Principal will approve concessions and cancellations.
4. How common cheques and demand drafts are, and whether bank charges for bounced cheques apply.
5. Which system holds the current dues (for the opening-balance template).
6. Whether hostel, transport or activity fees exist today (manual charges until Phase 7).
7. Whether parents expect printed fee demand notices (invoice PDF) in Phase 5, or receipts only. **Assumed: receipts only**; invoice printing can be added in 5C if needed.

## 10. Security review 5A-M1 — carried into the service milestones (2026-11-20)

Fixed in the draft migration / pure modules: M1 (receipt and allocation immutability triggers), M2 (composite allocation keys), M4 (UTR space shared by UPI and bank transfer; cheque = number + bank + date), L1–L6, I5, I6 — see DEVELOPMENT_PROGRESS.md. To build with the services:
- **FC6 / M3:** a FIXED concession is **per invoice (per installment)**. The propose and approve screens show the value per installment **and the session total** for that student, so the approver sees the real yearly effect. (Owner may switch to "per session" with a remaining budget — KI-102.)
- **L5:** refuse a cancellation when the payment's collector is unknown (user removed) and refuse an approval when the proposer is unknown, unless the actor is Super Admin — and even then never the same person.
- **L7:** an idempotency-key replay returns the existing receipt only for the same collector, student and amount; anything else is a conflict.
- **I3:** late-fee waivers by the collector (FC7) appear in the concession register with who / when.
- **I4:** `StudentConcession.reason`, `fee_invoice.cancel_reason` and `fee_payment.cancel_reason` are read only with the fee permission that decides them, never in default selects, audit rows or CSVs; `receiptSnapshot` is built from a whitelist (school letterhead, student name / ID / class, items, amounts, method, reference, date, receipt number, collector name) — never Aadhaar, medical data, guardian phone or address.
- **I1:** a delegated admin without `fee.concession.approve` / `fee.refund` can no longer modify Principal accounts (anti-escalation working as intended; noted in AUTHENTICATION_AND_RBAC.md).

## 11. Security review 5A-M2 — carried forward (2026-11-20)

Fixed in 5A-M2: M1 interim freeze (ever-active structures in invoiced classes), M2 (items re-checked on activate / copy), L1 (only {SEQ} takes a width; `validateFormat` too), L4 (totals fit Decimal(12,2)), L5 (closed sessions don't block deactivating a head), L6 (RBAC integration cases for the number formats; Parent refused at service level).
- **5A-M4 (generation):** add `FeeInvoice.structureId` and freeze exactly the invoiced structures (KI-103); generation and invoice cancellation take `lockFeeSetup` first (I5).
- **5B (issue / collection), L2:** render the receipt / invoice number inside the transaction and refuse with a fixed message if it exceeds 40 characters or {CODE} has no short code (the profile or session names may change after the formats were saved).
- **KI-104 (L3) resolved:** once numbers exist, only `settings.manage` may change the formats.

## 12. Security review 5A-M3 — carried forward (2026-11-20)

Fixed: M1 (every fee write right counts at ALL scope only — `fees.policy.authorizeFeeWrite`, also in setup), M2 (a template's value and heads are fixed while a proposal is pending; approval refused for a deactivated template), L3 (session effect counts only billed installments and applicable heads), L4 (charge audit carries the amount; removal carries a before-state), L5 (charges refused for promoted / detained enrollments and installments outside the student's dates), L6 (active structures loaded once per register), Info (student search only for fee staff who act on students; LIKE wildcards escaped).
- **Accepted (L7):** the student search term is in the URL of an authenticated, same-origin page (browser history / server logs). Revisit with the collection screen (5B), which should POST its search.
- **5A-M4:** when a concession is approved or revoked, re-price the student's unpaid open invoices in the same transaction (FC6); stacked concessions on one invoice follow fee-calc (percents add, capped at 100 %).
- Proposals for LEFT enrollments stay allowed (unpaid dues may still be reduced).

## 13. Security review 5A-M4 — carried forward (2026-11-20)

Fixed: M1 (cancel only while the session generates invoices, so a cancelled invoice can always be re-issued; the invoices list flags cancelled invoices not issued again), M2 (refusal tests for every invoice function incl. narrow-scope custom roles), M3 (a charge for an installment already invoiced is refused), L1 (re-pricing locks with the full "unpaid" predicate), L2 (fixed line order), L3 (issue checks the previewed count, total and structure), L4 (settings row FOR SHARE during numbering; format / amount failures are fixed messages; invoice-number collisions named), L5 (re-created charges re-checked for billability; ids audited).
- **5B:** collection takes the per-student lock and must also take it before re-pricing touches the student's invoices (order: fee setup → student → invoice rows → sequence).
- **5C reports:** a "cancelled and not re-issued" register (cancelled invoices with no live replacement) next to the concession register (R4).

## 14. Security review 5B-M1 — carried forward (2026-11-21)

Fixed: M1 (payment date at most 7 days back — `BACKDATE_DAYS` — late fee always as of today, receipt-number year from today, backdating audited), M2 (waiver kept with its amount and reason on the zero LATE_FEE line — KI-105 for its own columns), M3 (a waiver only on invoices this payment pays), L1 (idempotency key checked again under the student lock), L2 (only the locked invoice rows are read), L3 (re-pricing takes the student lock after the setup lock), L4 (real calendar dates; cheque dated within the 90 days up to the payment; cheque date only for cheques), L5 (reference indexes matched by name; system codes reserved), L6 (UPI / bank / card references compare as letters and digits), L7 (the counter lists the student's receipts of the last 24 hours).
- **Owner decision (optional):** the 7-day backdating window could become a school setting.
- **5B-M3 (cancellation):** a replay of a cancelled receipt's key reports it as cancelled (done); reversal must keep the frozen LATE_FEE line consistent and re-take the student lock.
- **Before go-live:** KI-106 (non-owner runtime database role).

## 15. Security review 5B-M3 — carried forward (2026-11-22)

Fixed: M1 (a cancellation that leaves an invoice with no live payment undoes its frozen late fee and waiver lines — removed, or voided to zero when allocation history references them — so a bounced cheque can't freeze a PER_DAY late fee low and waive-then-cancel can't waive it for good), L1 (cancel audit lists invoice ids and the invoices whose late fee was undone), L2 (lock order for `fee_payment` rows written down in `fees.tx.ts`). Also: `cancelInvoice` counts only live allocations.
- **M2 — resolved (owner decision 2026-11-22, option b):** a canceller who also holds `fee.collect` (the Accountant) cancels only receipts recorded TODAY (school time zone); older ones need the Principal or a Super Admin; a receipt that paid a closed session's invoice needs a Super Admin (sessions locked FOR SHARE during the cancel). `receiptCancelRefusal` NOT_SAME_DAY / SESSION_CLOSED; unit + integration cases. Still open: a cancelled-receipt count for the Principal (5C register).
- **KI-105 (extended):** a waiver given with a payment that is later cancelled stays while an earlier live payment remains on the invoice (no provenance column). The planned waiver columns should carry the payment id.
- After an undo, the late fee is worked out with the rule as it is NOW (a rule lowered or switched off since the freeze gives a lower fee).
- Re-check (Low, KI-105): a PER_DAY late fee frozen by a cancelled payment stays while an earlier live payment remains — `frozen_by_payment_id` with the next fee migration. PER_DAY re-accrual covered by the pure rule `fee-rules.lateFeeFrozen` + unit cases (2026-11-22).
- **5B-M2:** writing `printCount` must take the student lock before the payment row.

## 16. Security review 5B-M2 + M2 rule — carried forward (2026-11-22)

No Critical / High / Medium. Fixed: L1 (cancellation locks the receipt's sessions FOR SHARE BEFORE the student lock — order session → student → payment → invoices, as concession approval; avoids a three-way deadlock with a queued session close), L2 (only `fee.collect` holders count prints: ORIGINAL, then DUPLICATE; other readers get an uncounted "OFFICE COPY — NOT FOR ISSUE", audited as a view), L3 (render first, count afterwards only if count and status are unchanged — a failed render never uses up the ORIGINAL).
- Accepted (owner trade-off): two Accountants can still cancel each other's receipts on the same day; the cancelled-receipt register (5C) and the Principal's view cover it.
- Info: a browser PDF viewer that re-fetches on save counts another print (DUPLICATE); the rate limit (60 / 10 min / user) bounds it.

## 17. Security review 5C-M1 — carried forward (2026-11-22)

No Critical / High. Fixed: M1 (defaulters CSV: guardian name + phone only when the caller also passes the student-export rule D8, `admission.read` ALL; the page still shows them with `student.read` ALL; the Accountant's download has none), L1 (outstanding by class capped at 20,000 students), L2 (export audit records the filter values: session, dates, grouping, overdue days).
- **Owner decision (optional):** FC20 says defaulters include the guardian's phone "needed to call". On screen the Accountant sees it; should the Accountant also be able to DOWNLOAD it (overriding D8 for this one report)? Recommendation: no — call from the screen.
- Info: the reports page itself isn't rate limited (only the export); every report is a bounded, grouped query.
