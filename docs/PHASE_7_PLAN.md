# Phase 7 — School Operations: assessment and implementation plan

**Status: APPROVED — owner approved all decisions O1–O37 "as recommended" on 2026-11-26 (drafted by the architect agent the same day). Nothing is built yet; 7A starts after Phase 6 verification closes.** Like Phases 3–6, Phase 7 is split so each part has its own review, verification and closure (O1):
- **7A** transport;
- **7B** library;
- **7C** certificates and public verification;
- **7D** inventory and assets;
- **7E** school documents and internal events;
- **7F** remaining imports, exports and reports;
- **7G** (optional, gated) transport and library cards in the parent / student portal.

The architect drafted this from the code. File:line references were checked by the architect, not re-verified by the main session.

**Open items carried in.** They don't block planning, but they block "complete":
- **KI-059:** integration and e2e runners still can't read `TEST_TARGET_*`. Phases 2B–6 are unverified on Test. Phase 7 builds on students (2B), HR (3A), fees (5) and the notifications module (6C-M2).
- **Phase 7 must not depend on 6C-M5.** This plan therefore:
  - changes **no** portal read path (events are a separate staff-only model, O28);
  - adds staff notifications **beside** the portal delivery path, not inside it (§2.5);
  - defers every family-facing view to the gated 7G (O30).
- **KI-106:** the runtime role owns the tables. The application-level "append-only" rules for stock movements and certificates are only as strong as that role, so it stays a Phase 10 go-live blocker.
- **KI-037:** the public verification page doesn't exist yet. Certificates need it, so Phase 7 closes it (7C-M4).
- **KI-089 / KI-090 / KI-099:** `documents.issueDocument` requires `document.generate`, so no module can issue a verifiable document under its own permission. Certificates need that path, and this plan supplies it (ADR-050). That path also unblocks those three KIs later; they are not closed here.
- **KI-051:** the built-in PDF fonts are WinAnsi only. Names or certificate text in Devanagari or other Indian scripts **won't render**. TCs are often bilingual. See question 6 and risk R9.
- **KI-104 precedent:** number formats lock to `settings.manage` once the first number is issued. This plan applies the same rule to certificate, accession and asset-tag formats.

---

## 1. Starting point (checked in the code)

### 1.1 What exists and is reused

**Permissions already in the catalog** (`src/lib/rbac/catalog.ts`):
- `transport.read` / `transport.manage` / `transport.assign` (lines 78-80); `library.read` / `library.manage` / `library.issue` (97-99); `inventory.read` / `inventory.manage` (100-101); `certificate.issue` (44); `document.generate` / `document.revoke` (42-43); `import.run` / `export.run` (103-104).
- Totals are 89 permissions / 13 roles / 320 grants. Permissions were counted here (89); confirm grants with `npm run rbac:matrix`.

**Default grants:**
- **Transport Manager:** `transport.*` plus `student.read` **ASSIGNED** (catalog.ts:305). `students.policy.ts:23-26` defines ASSIGNED as **class-teacher sections only**, so a Transport Manager sees **no** students today. That is fail-closed and correct, but it means transport needs its own student lookups (§2.1).
- **Librarian:** `library.*`, `student.read` ALL and `employee.read` ALL (314).
- **Nobody except Super Admin holds `inventory.manage`.**
- **Principal / Vice Principal:** `certificate.issue` (231, 250). Neither holds `document.generate`, which School Admin and Admission Officer hold.
- **Student:** `library.read` SELF (336). Every staff path must keep refusing it.

**Fees hook for transport (FC18):**
- `StudentFeeCharge` has `source` MANUAL / TRANSPORT and `sourceRef` (`prisma/schema.prisma:2322-2348`).
- A partial unique `(student, session, installment, source_ref) WHERE source = 'TRANSPORT' AND deleted_at IS NULL` already exists (:2345).
- Invoice generation picks up **unbilled** charges for the installment (`src/modules/fees/invoices.service.ts:79-83`). Charges become CHARGE lines **with no concession** (`invoice-build.ts:53`).
- `addCharge` refuses system kinds and installments that are already invoiced (`concessions.service.ts:392-399`). `removeCharge` refuses non-MANUAL rows with "Transport charges are managed by transport" (:422).
- `cancelInvoice` re-creates the invoice's charges, keeping `source` / `sourceRef` (`invoices.service.ts:214-228`).
- System categories are upserted on first use, as in `opening-balances.service.ts:75`. Concession templates **exclude** TRANSPORT (`concessions.service.ts:87-88`).
- **Receipt immutability is preserved** if transport only ever touches **un-invoiced** charges. Issued invoices, items and receipts are never written by Phase 7.

**Fee locks** (`src/modules/fees/fees.tx.ts`):
- `lockFeeSetup` is a global advisory lock taken by charge, generation and cancel writes.
- `lockFeeStudent` is taken by collection.

**Outstanding dues:**
- `openInvoicesOf(db, studentId, asOf)` (`fees/ledger-reads.tx.ts:16`) gives open invoices with the live late fee, and performs no authorization.
- A summary `outstandingForStudentTx` (named in the Phase 5 plan for certificates) **does not exist yet**.

**Sequences** (`src/lib/sequence.ts`):
- `nextSequence` / `nextSequenceBlock` are row-locked and roll back with the caller.
- `formatSequence` supports `{CODE} {YYYY} {YY} {SESSION} {CLASS} {SEQ:n}`. Formats live in `SchoolSetting.idFormats` JSON; fee formats are read through `settings.service.readFeeSettingsTx` (:420).
- **There is no function to start a counter at a given value** (needed to continue a paper TC book or accession register).

**Documents and PDF** (`src/modules/documents/documents.service.ts`):
- `issueDocument` renders outside the transaction, stores a PRIVATE PDF, writes `GeneratedDocument` with an HMAC'd code (ADR-031) and audits. It **requires `document.generate`** (:64) and **has no callers** in `src/`.
- `revokeDocument` requires `document.revoke`. `verifyDocument` is the public lookup (:153), with no route (KI-037).
- `GeneratedDocumentType.CERTIFICATE` exists (schema :454-461).
- Templates exist for the letterhead, receipt, report card, salary slip and activation slip. `@react-pdf/renderer` **is installed and used** (CLAUDE.md still says "planned" — a doc fix).
- `DocumentTemplate` is listed for settings in the module map but **is not in the schema**.

**Notifications** (`src/modules/notifications/notifications.service.ts`):
- In-app only, deduped, after-commit, batched.
- `LINK = /^\/portal\/…/` (:34): **links are portal-only**, and the module header says the staff inbox in the ERP header "is later". There is **no staff inbox**.
- `notificationTarget` maps key prefixes to portal capabilities; unknown keys are never shown in the portal (:80-87).

**Cron and rate limits:**
- Only `src/app/api/cron/cleanup/route.ts` exists. FREE_TIER says to run it **daily** (it wakes Neon compute once).
- `lib/rate-limit.ts` has `hitLocal` (an in-process limiter, :139), already used by the public file route (:56).

**Import:**
- `lib/import/tabular.ts` reads 512 KB / 500 rows / 30 columns in memory, with a zip-bomb guard.
- The established per-module pattern is template → upload → preview → confirm through the service: marks (ADR-039) and opening balances (`fees/opening-balances.service.ts:51-79`).
- **The generic `ImportJob` / `ImportRow` pipeline was never built.**
- Deferred to "later" and still missing: **student import** (`PHASE_2B_CLOSURE_REPORT.md:66`), **staff import** (`PHASE_3_PLAN.md:46`), and ID cards plus the QR verification page.

**Exports:**
- Routes follow one pattern (same-origin POST → session → `RULES.export` → service → `private, no-store`): students, employees, staff attendance, payroll, fees reports.
- The employee export is `export.run` + `employee.read` (`hr/employees.service.ts:392-398`). This matters for O33: a Librarian (who holds `employee.read` ALL) given `export.run` could export the staff directory.

**Students:**
- `changeStudentStatus` locks the student, sets enrollments LEFT, writes the status change and deactivates the student account in one transaction (`students.service.ts:343-392`).
- It calls **no** transport or library hook, and it shouldn't (dependency direction). Phase 7 is **pull-based** for leavers (§2.4).
- `registration.ts` holds the shared registration logic, called only inside admission approval (:5-11). Student import must reuse it under the same locks.

**Calendar:**
- `AcademicEvent` (schema :2051-2066) is read by `academic/calendar.portal.ts`, so it is **family-visible**. Adding staff-only rows to it would change a Phase 6 portal read that is still unverified.

**HR:**
- `Employee` (:1048-1116) has `staffType`, `employmentStatus`, `workPhone` (directory tier) and `personalPhone` (personal tier). There is no driving-licence field; licence documents fall under EmployeeDocument `OTHER`.

### 1.2 What is missing (summary)
1. Every transport, library, inventory, certificate, school-document and internal-event table. The DATABASE_SCHEMA §9 / §11 drafts are a starting point and are revised in §5.
2. A fees-owned function through which transport and library write charges (sync, never touching invoiced lines).
3. A module-authorized document issuing path, gap-free certificate serials, counter seeding, and the public `/verify` page.
4. A staff in-app inbox and a daily alert step (document expiry, licence expiry, maintenance due, event duties).
5. Concurrency-safe stock, loan and seat invariants, with tests.
6. Student, staff and operational imports, plus the operational reports and exports, with a gate audit proving redaction.

---

## 2. Proposed design (summary)

### 2.1 Module ownership

| Concern | Owner (new unless noted) | Depends on | Notes |
|---|---|---|---|
| Vehicles, vehicle documents, crew, fare slabs, routes, stops, student allocations, transport reports | **`transport`** | students (enrollment and guardian reads through `*.tx.ts`), hr (employee reads), fees (`syncTransportChargesTx`), files, settings, identity (alert recipients), notifications | Never reads fee tables. Has its own student search under `transport.assign` (the `searchStudentsForFees` precedent); it does not widen `students.policy` ASSIGNED |
| TRANSPORT / LIBRARY charge writes, the system categories, the outstanding summary | **`fees`** (existing): new `fees/charges-sync.tx.ts` and `fees/outstanding.tx.ts` | — | The **only** writer of `student_fee_charge`. Caller-authorized `*.tx` functions, documented "NO AUTHORIZATION HERE" like `ledger-reads.tx.ts`. Never touches invoiced charges |
| Books, copies, loans, fines, loan rules | **`library`** | students, hr, fees (`addLibraryChargeTx` / `removeLibraryChargeTx`), settings, identity, notifications | — |
| Consumable items, stock, movements, assets, maintenance, disposal, locations, vendors | **`inventory`** | hr (custodian employee), settings, identity, notifications | Not session-scoped (not academic data, rule 8 n/a) |
| Bonafide, character and transfer certificates; register; TC clearance | **`certificates`** | students, fees (`outstanding.tx`), library (`openLoansOfStudentTx`), transport (`liveAllocationOfTx`), documents, settings | Separate from `documents`, which stays infrastructure (branding, registry, verification) |
| Issuing path for registered documents, public verification | **`documents`** (existing): split `issueDocument` into `prepareIssuedDocument` + `recordIssuedDocumentTx` | files, settings | ADR-050. `issueDocument` stays as the `document.generate` wrapper |
| Institutional documents register | **`schooldocs`** | files, settings, identity, notifications | O27 |
| Internal (staff-only) events and duty roster | **`events`** | hr, settings (session), identity, notifications | O28. Calendar and portal untouched |
| Staff inbox (`/erp/inbox`, header bell), daily alert fan-out | **`notifications`** (existing): new `notifications.staff.ts` | — | ADR-055. The portal `deliver` path stays byte-identical |
| Active users holding a permission (alert recipients) | **`identity`** (existing): new `identity/permission-holders.tx.ts` | — | Staff accounts only (account kind ≠ portal), active, permission at ALL |
| Imports (students, staff, library, inventory, transport allocations) | Each target module's `*-import.service.ts` | `lib/import/tabular` + new pure `lib/import/flow.ts` | ADR-056. `importexport` is **not** created |
| Counter seeding | **`lib/sequence`**: `ensureSequenceAtLeast(tx, key, value)` | — | Monotonic raise only (§2.3) |

**Dependency direction** (check with `npm run check:deps` after each module):
- transport → students, hr, fees, identity, notifications, files, settings;
- library → students, hr, fees, identity, notifications, settings;
- certificates → students, fees, library, transport, documents, settings;
- inventory, events, schooldocs → hr / files / identity / notifications / settings;
- **nothing depends on the new modules** except certificates (→ transport, library) and the app layer.

Students, HR and fees never import a Phase 7 module.

**Watch:** `identity` already imports `academic` (`users.service.ts`, noted in Phase 6). `identity/permission-holders.tx.ts` must import nothing from students or HR.

**Request flow:** unchanged. Action or route (≤ 30 lines) → Zod `.strict()` → service (`authorize` → policy → transaction with the §2.7 lock order → `audit`) → after commit `notifications.afterCommit*`. Daily alerts are called from the cron route (app layer), never from `lib/maintenance` (`lib` can't import modules).

### 2.2 Transport fee without breaking receipt immutability (ADR-049, O2–O5)

- **Fees owns a sync function.** `fees.syncTransportChargesTx(tx, { studentId, academicSessionId, lines })`, where each line is `{ allocationId, installmentIds[], amount }`. It:
  1. takes `lockFeeSetup`;
  2. upserts the TRANSPORT category (system kind, as `OPENING_BALANCE` is);
  3. **soft-deletes the student's un-invoiced TRANSPORT charges** for the session that the new lines don't reproduce;
  4. creates the missing ones (`sourceRef = allocationId`; the existing partial unique makes re-runs idempotent);
  5. audits the counts and the amount (the charges L4 precedent; no note text).

  Charges already on an invoice (`invoiceItem` set) are **never** touched.
- **Which installments are billed (pure, `transport/transport-rules.ts`):** an installment of the allocation's session is billed when **its due date is inside [startOn, endOn ?? session end]** and its invoice is **not yet issued**.
  - There is no day-level proration (O4).
  - Already-invoiced installments are never re-billed or credited. Exceptions are handled by the office with a MANUAL charge or a concession.
  - Leavers: generation already skips installments after `leftOn` (`billableInstallments`). Their remaining un-invoiced charges are harmless, and they are dropped when the allocation is ended.
- **Triggers:**
  - allocation create / change / end;
  - a fare-slab amount change (re-sync of every live allocation on that slab — bounded, ≤ 2,000 allocations per transaction, 60 s);
  - the next-session rollover.
- **Interaction with `cancelInvoice`:** cancelInvoice re-creates TRANSPORT charges with the same `sourceRef`. A later sync reconciles them. Both run under `lockFeeSetup`, so the order is deterministic.
- **What the counter and receipts see:**
  - an ordinary CHARGE line whose description is the category name snapshot ("Transport fee" — the school names the category on first use);
  - no route or stop text in the description, so the parent ledger whitelist (fees.portal) needs no change.
- **Transport concessions (staff wards, siblings): not in Phase 7** (O37). CHARGE lines carry no concession today. A fare override on an allocation would be a concession without maker-checker, so it is rejected.

### 2.3 Certificates, serials and verification (ADR-050, ADR-051, ADR-052)

**Lifecycle:** DRAFT (prepared, editable) → ISSUING (serial assigned) → ISSUED (PDF stored, verifiable) → CANCELLED (reason; document revoked). A DUPLICATE is a new row with the **same serial**, `copyKind = DUPLICATE` and `duplicateOfId`; the original's document is revoked ("duplicate issued").

**Serials:**
- One series per type, from settings formats `certBonafide` / `certCharacter` / `certTransfer`. There is **no default**: issuing refuses until the format is set (FC12 precedent).
- Tokens: `{CODE} {YYYY} {YY} {SESSION} {SEQ:n}`.
- The serial is taken in **transaction 1** of issue, last (lock order §2.7), so it is gap-free.
- A failure after transaction 1 leaves the certificate ISSUING with its serial. "Finish issuing" retries the render with a **fresh** verification code (the old one was never printed or stored), so no serial is ever lost or reused.
- Cancelled certificates keep their numbers.

**Starting number:** `lib/sequence.ensureSequenceAtLeast(tx, key, n)` runs `INSERT … ON CONFLICT DO UPDATE SET value = GREATEST(value, n)`. It can only **raise** a counter, so it can never create a duplicate.
- It is allowed for certificates before the first issue of the series ("continue from the paper register": the next TC is N+1).
- It needs `settings.manage` and is audited.
- The same function serves legacy accession numbers, asset tags and imported admission numbers (O14, O19, O32).

**Issuing path (ADR-050):**
- `documents.prepareIssuedDocument(render)`: code → hash → render → `prepareUpload`, all **outside** the transaction.
- `documents.recordIssuedDocumentTx(tx, ctx, prepared, { type, subject })`: records the file and `GeneratedDocument` and audits, **inside the caller's transaction**.
- Neither checks `document.generate`. The caller module authorizes.
- A source-scan unit test allowlists the callers: `documents.service` (the `issueDocument` wrapper) and `certificates/*.service.ts`. KI-089 / KI-090 / KI-099 can join the allowlist later with their own review.

**Content:**
- Fixed, neutral templates in code (`documents/templates/certificate-{bonafide,character,transfer}.tsx`).
- Fields come from records (name, IDs, DOB, guardians, class and section, admission date, leaving date), plus fields entered at preparation: purpose; conduct; TC fields the ERP doesn't hold (O24, question 5).
- Everything is frozen in `snapshot`. Templates must pass the existing non-WinAnsi check (KI-051 test).

**Public verification `/verify` (ADR-052, closes KI-037):**
- The printed code and the verify URL are printed as text (no QR unless O25 approves a dependency). A link carries the code in the **fragment**; the page strips it and POSTs it.
- Rate limiting: `hitLocal` per IP **before any database work**, then the DB limiter.
- Malformed codes are rejected without a DB query.
- Results are cached in-process for 5 minutes (LRU, keyed by the code hash, max 1,000).
- The response shows type, serial, issue date, school name and valid / revoked status only: no name, class or ID.

### 2.4 Stock, loans and seats: invariants under concurrency (ADR-053, ADR-054)

**Inventory (count-only, O16):**
- `inventory_stock(item_id, location_id)` holds `quantity int CHECK (quantity >= 0)`.
- Every change appends an `inventory_movement` (signed quantity, `balance_after`, reason) in the same transaction, after locking the affected stock rows `FOR UPDATE ORDER BY item_id, location_id`.
- Transfers lock both rows and write two movements under one `transfer_group_id`.
- Corrections are **reversal movements** (`reverses_id` unique); there is no update or delete path.
- Invariants checked by a reconciliation query and tests: on-hand = Σ movements per (item, location); never negative; one reversal per movement.

**Library:**
- One open loan per copy: partial unique `(copy_id) WHERE returned_on IS NULL`.
- Copy status and loan rows change together under the copy row lock.
- Borrower limits: a per-borrower advisory lock (`school_erp.library.borrower:<kind>:<id>`) taken **before** the copy locks, so two desks can't push a borrower over the limit.

**Transport seats:**
- Capacity is per route **per direction** (PICKUP / DROP), and equals the route's vehicle seating capacity (or a lower route cap).
- It is counted over LIVE allocations whose enrollment is ACTIVE, under the route row lock.
- A change of stop or route locks **both** routes in id order.
- Swapping a route's vehicle for a smaller one is refused while allocations exceed its seats.

**Leavers (pull-based, no reverse dependency):**
- Capacity counts exclude non-ACTIVE enrollments.
- The transport dashboard lists "allocated students who have left" with a one-tap end.
- The TC clearance check shows any live allocation and open loans.
- The library lists open loans of leavers and of staff who left.

### 2.5 Staff inbox and expiry alerts (ADR-055, O7, O29)

- **New `notifications.staff.ts`:**
  - `deliverStaff(drafts)` accepts `/erp/` links only (its own regex);
  - recipients must be staff accounts (resolved by `identity.permissionHolderIdsTx(key)`, which excludes portal accounts);
  - dedupe key prefixes are staff-only: `vehdoc:`, `crewlic:`, `schooldoc:`, `assetmaint:`, `duty:`, `lowstock:`.
- **The portal's `deliver` and LINK rule are unchanged.** `notificationTarget` already hides unknown prefixes in the portal. A unit test asserts both directions: no staff key renders in the portal, no portal key renders in the ERP.
- **Read-time re-check:** each staff prefix maps to a permission (`vehdoc` → `transport.read`, and so on). The ERP inbox shows a row only while the user still holds that permission at ALL (the portal M1/M2 lesson).
- **Header bell:** the unread count renders **on navigation only**. No polling, no auto-refresh.
- **Daily alerts step:** `/api/cron/cleanup` (already daily, `CRON_SECRET`) calls each module's `dailyAlerts(today)` after the cleanup (`transport`, `schooldocs`, `inventory`, `library`).
  - Each makes 1–2 indexed queries (`expires_on`, `next_due_on`, `due_on` WHERE open), bounded with `take` ≤ 500.
  - Thresholds come from settings (default 30 / 7 / 0 days — a product default, not a school fact; editable).
  - Dedupe `vehdoc:<docId>:<threshold>` means one alert per threshold.
  - **No email, no SMS.** The same data shows live on each module dashboard ("Expiring in 30 days").

### 2.6 Imports and exports (ADR-056, O31–O33)

**Imports:**
- They stay **in memory**: template → upload (`lib/import/tabular`, ≤ 512 KB / 500 rows per file) → preview (no writes; a row-level problem list) → confirm (the same bytes re-uploaded and hash-compared, or a server-side preview digest; the opening-balances precedent) → one transaction per file through the module's own service locks.
- All-or-nothing per file, and idempotent by natural key (admission no., employee code, accession no., asset tag, (student, session) for allocations).
- The `ImportJob` / `ImportRow` pipeline is **not** built: no staging tables in the 512 MB budget and no worker. The ADR records this as superseding the import-export skill's 10 MB / 20,000-row pipeline; the skill text must be updated.
- New pure `lib/import/flow.ts`: header matching, a duplicate-in-file check, a problem list and a digest. It is shared and imports nothing above `lib`.

**Exports:**
- The existing route pattern applies to every new CSV: same-origin POST, `RULES.export`, ≤ 5,000 rows (refused, never truncated), `lib/csv` formula-safe, audited with filters and row count only.
- Gate: `export.run` + the domain read at ALL.
- Column whitelists live in the services, and sensitive columns are flagged and dropped unless the matching permission is held (§11).
- **Print views** (HTML with print CSS, no CSV) of operational lists (route manifests, overdue slips, stock count sheets) need only the domain read. This avoids widening `export.run`.

### 2.7 Lock orders (new)

| Workflow | Order |
|---|---|
| Allocation create / change / end | student row FOR SHARE (students helper; serializes with `changeStudentStatus`) → route rows FOR UPDATE ORDER BY id → allocation row FOR UPDATE → **fees: `lockFeeSetup`** → charge sync. Fees never takes transport locks, so taking `lockFeeSetup` after transport locks can't deadlock. Update the `fees.tx.ts` comment ("first among fee locks") |
| Fare-slab amount change | slab row FOR UPDATE → affected allocations (read) → `lockFeeSetup` → sync per student |
| Route vehicle / cap change | route row FOR UPDATE → seat count |
| Rollover to the next session | target routes FOR UPDATE ORDER BY id → per student: as allocation (batched ≤ 200 per transaction) |
| Library issue (1..n copies) | borrower advisory lock → copy rows FOR UPDATE ORDER BY id → loan inserts |
| Library return / lost / damaged | copy row FOR UPDATE → loan row FOR UPDATE → fine row insert → (student fine and O12) `lockFeeSetup` → LIBRARY charge |
| Fine waive | fine row FOR UPDATE → (if charged and not invoiced) `lockFeeSetup` → soft-delete charge; if invoiced → refused (KI) |
| Stock receive / issue / adjust | stock rows FOR UPDATE ORDER BY (item, location) → movements → quantities |
| Stock reversal | original movement FOR UPDATE → stock rows ORDER BY (item, location) → reversal movement |
| Asset create | sequence (tag) **last** |
| Asset move / maintenance | asset row FOR UPDATE → child row |
| Disposal decide | disposal row FOR UPDATE → asset row FOR UPDATE → status DISPOSED |
| Certificate issue, transaction 1 | certificate row FOR UPDATE → student row FOR SHARE (status re-check) → clearance reads (no locks) → `school_setting` FOR SHARE (format) → **sequence last** |
| Certificate issue, transaction 2 (after render) | certificate row FOR UPDATE (still ISSUING, version) → `recordIssuedDocumentTx` → ISSUED |
| Certificate cancel / duplicate | certificate row FOR UPDATE → generated_document update (revoke) → (duplicate) new row with the same serial |
| School document supersede | current row FOR UPDATE → new row → old SUPERSEDED |
| Student import (per file) | session FOR SHARE → section rows FOR UPDATE ORDER BY id (capacity) → `ensureSequenceAtLeast` (if legacy numbers) → sequence blocks **last** |

All of these use `lock_timeout` 5 s and the busy mapping (KI-044). PDF rendering, image work and hashing run outside transactions.

### 2.8 Caching, Neon budget and rate limits

- No polling anywhere. Dashboards make bounded, indexed queries per page view.
- Expiry, overdue and low-stock panels are computed live (partial indexes WHERE open / not deleted).
- `/verify`: `hitLocal` + LRU (§2.3).
- New `RULES`:

| Rule | Limit |
|---|---|
| `verifyPerIp` (local) | 20 / 10 min |
| `verifyPerIpDb` | 60 / h |
| `documentPdf` (certificate download / reprint) | 60 / 10 min / user |
| `importUpload` (preview + confirm) | 20 / 10 min / user |

  The existing `export` rule covers the new CSVs.
- The daily alerts step adds a handful of queries to a cron that already wakes compute once a day.
- File bytes (vehicle documents, school documents, certificate PDFs) go to storage, never into Postgres.

---

## 3. Owner decisions needed (O1–O37)

| # | Decision | Recommendation |
|---|---|---|
| **O1** | Split and order | **7A transport → 7B library → 7C certificates → 7D inventory → 7E school documents and events → 7F imports / reports**, with 7G optional. If TC season (March–April) is the priority, move 7C first; its library clearance check then arrives with 7B |
| **O2** | Transport fee mechanism | **TRANSPORT `StudentFeeCharge` rows written by a fees-owned sync** (FC18, ADR-049), billed on the normal installment invoices. Rejected: a separate transport invoice (a second invoice series and its own collection); fee-structure lines per class (fares differ per stop) |
| **O3** | Fare model | **Fare slabs (zones) per session** with an amount **per installment** and optional `oneWayAmount` (null = same); each stop points to a slab. The school defines all amounts (rule 13). Alternatives: an amount per stop, or a flat route fare |
| **O4** | Mid-session start / end / change; proration | **No day proration.** An installment is billed when its **due date** falls inside the allocation window and its invoice isn't issued yet. Invoiced installments are never changed. A stop or route change = end + new allocation (history kept). Exceptions: MANUAL charge or concession by fee staff |
| **O5** | Fare change mid-session | Applies to **un-invoiced** installments of every live allocation on the slab (re-sync in the same transaction, preview first). Issued invoices unchanged |
| **O6** | Capacity | **Hard block** per route per direction = vehicle seats; the school may set a lower route cap, never a higher one. **No override.** Vehicle swap to fewer seats than allocated is refused |
| **O7** | Vehicle documents and expiry alerts | Types RC, INSURANCE, FITNESS, PERMIT, PUC, ROAD_TAX, OTHER (+ label); one current per type; PDF / JPEG / PNG ≤ 10 MB private. The school marks which types are **mandatory**. Alerts at 30 / 7 / 0 days (setting) in-app to `transport.manage` holders, plus the dashboard. **Warn, don't block** route operation (the school decides operationally; documented) |
| **O8** | Drivers / conductors / attendants | **`TransportCrew`**: either an **Employee** (NON_TEACHING, ACTIVE) **or an external person** (name, phone, agency — for contracted buses). Driver ⇒ licence number + expiry (personal data: masked, `transport.manage` only, never audited in clear) and an optional licence scan. Licence expiry alerts as O7 |
| **O9** | Who can be allocated | **Students only**, one live allocation per student per session, mode BOTH / PICKUP / DROP. Staff transport out of scope (KI) |
| **O10** | Next session | **Rollover tool:** preview → confirm copying live allocations of PROMOTED students onto their next-session enrollments and the same-coded routes / stops, capacity-checked; failures listed |
| **O11** | Library fine policy | School-defined `finePerDay`, `graceDays`, `fineCap` per borrower kind; **0 = no fines**; **staff: no fines** by default (setting). Holidays are not excluded (calendar days; simpler; the school may ask) |
| **O12** | Where fines go | **Student fines → a LIBRARY fee charge** on the next un-invoiced installment of the current session, collected at the fee counter (no second cash point, no library receipt series). If no such installment exists, the fine stays OPEN in the library and shows in TC clearance. Waiver by `library.manage` with a reason **before invoicing only**. Rejected: cash at the library desk |
| **O13** | Lost / damaged copy | Copy → LOST / DAMAGED; replacement charge = the copy's recorded price or an entered amount, through the same channel as fines |
| **O14** | Accession numbers | New copies from `lib/sequence` (format `libraryAccession`, no default); **legacy register numbers imported verbatim**; counter raised with `ensureSequenceAtLeast` past the numeric max |
| **O15** | Loan rules | Per borrower kind: max open loans, loan days, renewals. **No defaults**: issuing refuses until set |
| **O16** | Inventory valuation | **Count-only.** Consumables tracked in **whole units** per location. Purchase cost recorded **for information** on receipts and assets (Decimal(12,2)); no FIFO / weighted average, no stock value report |
| **O17** | Depreciation | **Out** (KI) |
| **O18** | Disposal / write-off approval | Asset disposal is **maker-checker**: proposed with `inventory.manage`, decided with new **`inventory.approve`** (Principal), approver ≠ proposer (Super Admin included; CHECK). Consumable write-offs: reason only, no approval |
| **O19** | Asset tags | `lib/sequence` format `assetTag` (no default) + legacy tags imported verbatim + `ensureSequenceAtLeast` |
| **O20** | Certificate types and approval | Bonafide, Character, Transfer. **Prepare → issue** for all: prepared with new **`certificate.prepare`** (School Admin, Admission Officer) or by an issuer; issued with `certificate.issue` (Principal, VP). **TC: issuer ≠ preparer** (CHECK). Bonafide / character may be prepared and issued by one `certificate.issue` holder |
| **O21** | Numbering | A separate series per type (§2.3), formats required before first issue, a one-time start number allowed before the first issue, format locked to `settings.manage` after the first issue (KI-104 rule). Gap-free; cancelled keep their numbers |
| **O22** | TC and dues | **Warn, never block by default.** The issuer sees: outstanding fees (amount only to `fee.read` holders, otherwise "dues outstanding: yes"), open library loans / fines and a live transport allocation, and must tick an acknowledgement (audited as a flag). Setting `tcRequiresClearance` default **off**. Several Indian state rules and court decisions restrict withholding a TC for unpaid fees — **the school must confirm its legal position**; the code takes no side by default |
| **O23** | TC prerequisites, cancel, duplicate | The student must already be TRANSFERRED / WITHDRAWN / GRADUATED (existing `student.transfer` screen, linked from the TC page). One live original TC per student (partial unique). Cancel with reason (`certificate.issue`), document revoked. Duplicate: same serial, "DUPLICATE" stamped, original revoked, reason required |
| **O24** | Certificate wording and TC fields | Fixed neutral templates, frozen snapshot, stored PDF. TC fields: a common board-style set (prefilled where the ERP has data; the rest entered at preparation), **finalized against the school's board format** (question 5). School-editable wording deferred (`template.manage`, KI) |
| **O25** | QR on certificates | **Not now:** printed code + verify URL as text. A QR needs a new dependency (e.g. `qrcode`, MIT) → separate dependency review |
| **O26** | Certificate fee | **None in Phase 7** (the office may add a MANUAL charge). Ad-hoc invoices are a KI |
| **O27** | "School documents" | **An institutional records register:** affiliation / recognition, NOCs, safety and inspection certificates, insurance, registrations, policies. Private files, versions (supersede), expiry alerts, `confidential` flag. Not public downloads (Phase 8 CMS). **Confirm the interpretation** |
| **O28** | Internal events | **A separate staff-only `SchoolEvent` + `EventDuty`** (meetings, PTM planning, trips, sports day duties) in a new `events` module. The family-visible academic calendar and its portal read stay untouched (Phase 6 unverified). Families are told through notices or the calendar, as today |
| **O29** | Staff inbox | **Yes, in 7A** (ADR-055): ERP header bell + `/erp/inbox`, in-app only, permission re-check at read, daily alert step |
| **O30** | Portal visibility of transport and library | **Defer to 7G**, which starts only after 6C-M5 is closed (KI-059). Then: route, stop, times, vehicle number, crew display name, school transport desk number (settings) — never crew personal phones or licence data; the child's current loans and due dates and open fines. Needs `transport.read` CHILDREN / SELF, `library.read` CHILDREN, portal functions and IDOR rows |
| **O31** | Remaining imports | **Students** (existing students at go-live), **staff**, **library catalogue + copies**, **inventory opening stock + asset register**, **transport allocations**. In memory, ≤ 500 rows per file, one transaction per file, through the services. Generic ImportJob pipeline **not built** (ADR-056) |
| **O32** | Legacy IDs on import | **Legacy admission numbers imported verbatim** (unique; format-free); **Student ID generated** by `lib/sequence`; the admission-number counter raised past the legacy max (`ensureSequenceAtLeast`), refused if the current format could re-produce an imported value. Same for employee codes. This is an interpretation of rules 4 / 5 (numbers made outside the ERP are recorded, never generated) → ADR-056 |
| **O33** | Export permissions | CSV = `export.run` + domain read at ALL. **Grant `export.run` to Transport Manager** (+1), after an export-gate audit test shows it unlocks nothing else (it holds no `employee.read` ALL / `admission.read`). **Not to Librarian** (it would unlock the staff-directory export). Print views need only the domain read |
| **O34** | Catalog change | §4: **+5 permissions, +15 grants → 94 / 13 / 335** (baseline confirmed by `rbac:matrix`), synced to development and Test with approval (KI-062 procedure) |
| **O35** | New roles (Store Keeper, Transport Clerk) | **None.** School Admin gets `inventory.manage`; Super Admin can create custom roles at runtime (`ALLOWED_SCOPES` unchanged) |
| **O36** | Vehicle service / fuel logs, GPS tracking, maps | **Out** (KI). No maps or GPS service (free-only; child location data) |
| **O37** | Transport concessions | **Not in Phase 7** (KI): CHARGE lines carry no concession; a fees change with maker-checker later. No fare overrides on allocations |

---

## 4. RBAC (proposed)

| Capability | Super Admin | School Admin | Principal | Vice Principal | Accountant | Transport Mgr | Librarian | Admission Off. | Teacher / CT | Parent / Student |
|---|---|---|---|---|---|---|---|---|---|---|
| Transport read (`transport.read`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | 7G only |
| Vehicles, documents, crew, routes, slabs (`transport.manage`) | ✓ | — | — | — | — | ✓ | — | — | — | — |
| Allocate students (`transport.assign`) — writes fee charges via fees sync | ✓ | — | — | — | — | ✓ | — | — | — | — |
| Library catalogue read (`library.read`) | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | — | ✓ | Student SELF refused until 7G |
| Catalogue, loan rules, waive fines (`library.manage`) | ✓ | — | — | — | — | — | ✓ | — | — | — |
| Issue / return (`library.issue`); borrower names visible | ✓ | — | — | — | — | — | ✓ | — | — | — |
| Inventory read (`inventory.read`) | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| Inventory manage (`inventory.manage`) | ✓ | **✓ (new grant)** | — | — | — | — | — | — | — | — |
| Approve disposals (**new `inventory.approve`**) | ✓ | — | **✓** | — | — | — | — | — | — | — |
| Prepare certificates (**new `certificate.prepare`**) | ✓ | **✓** | — | — | — | — | — | **✓** | — | — |
| Issue / cancel / duplicate certificates (`certificate.issue`) | ✓ | — | ✓ | ✓ | — | — | — | — | — | — |
| Revoke any issued document (`document.revoke`) | ✓ | — | ✓ | — | — | — | — | — | — | — |
| School documents read (**new `schooldoc.read`**) | ✓ | **✓** | **✓** | — | — | — | — | — | — | — |
| School documents manage (**new `schooldoc.manage`**; confidential rows readable only with it) | ✓ | **✓** | — | — | — | — | — | — | — | — |
| Internal events manage (**new `event.manage`**) | ✓ | **✓** | **✓** | — | — | — | — | — | — | — |
| Internal events read | every staff account (own duties always; list with `academic.read` or `event.manage`) | | | | | | | | | never |
| CSV exports (`export.run`) | ✓ | ✓ | — | — | ✓ | **✓ (new grant, O33)** | — | — | — | — |
| Imports | students: `admission.approve` + `student.create` ALL; staff: `employee.manage`; library: `library.manage`; inventory: `inventory.manage`; allocations: `transport.assign` (domain permission, ADR-039 precedent; `import.run` not required) | | | | | | | | | |

**Catalog change:**
- **+5 permissions:** `certificate.prepare`, `inventory.approve`, `schooldoc.read`, `schooldoc.manage`, `event.manage` (89 → **94**).
- **Grants (+15):**
  - +5 Super Admin (automatic);
  - `certificate.prepare` School Admin + Admission Officer (+2);
  - `inventory.approve` Principal (+1);
  - `schooldoc.read` School Admin + Principal (+2);
  - `schooldoc.manage` School Admin (+1);
  - `event.manage` School Admin + Principal (+2);
  - `inventory.manage` School Admin (+1);
  - `export.run` Transport Manager (+1).
- **Totals:** **320 → 335** (confirm the baseline with `npm run rbac:matrix` first).
- Seed, RBAC_MATRIX and the development / Test sync use the KI-062 / KI-073 procedure, with approval.

**Scopes:**
- No new narrower scopes. Every Phase 7 write is honoured **at ALL only** (the fees `holdsAll` precedent): a custom role given a write at ASSIGNED / CHILDREN / SELF gets nothing.
- `library.read` SELF (Student) stays refused on every staff path until 7G.
- `ALLOWED_SCOPES` is unchanged until 7G adds `transport.read` CHILDREN / SELF and `library.read` CHILDREN.

**Module-authorized writes:**
- `transport.assign` writes fee charges and `library.manage` / `library.issue` write fine charges **only through the fees `*.tx` sync functions**, never through `addCharge`.
- Fee staff still can't remove TRANSPORT / LIBRARY charges (`removeCharge` refuses non-MANUAL; message updated).

**Invariants (tests):**
- maker ≠ checker for TC and disposals (Super Admin included);
- `inventory.approve` holders without `inventory.manage` can't move stock;
- every new endpoint gives 403 or the not-permitted screen for forbidden roles;
- portal accounts are redirected from every new `/erp/**` page (extends `tests/unit/portal-rbac.test.ts`).

---

## 5. Schema changes (migration outline, expand-only)

**Conventions for every migration:**
- `--create-only` → offline diff → hand edits (CHECKs, partial uniques in canonical `= ANY (ARRAY[…])` form, KI-055) → guard test `tests/unit/migration-phase7*.test.ts` → owner approval → development → Test.
- One transaction with `lock_timeout`.
- Money `numeric(12,2)`; school-local dates `date`; instants `timestamptz(3)`; ids `cuid(2)`; `version`, `created_at`, `updated_at` everywhere.
- Actor FKs → user SET NULL; domain FKs RESTRICT.
- Partial uniques are declared in `schema.prisma` (`partialIndexes` preview) for drift checks.
- Table-level details go to **database-engineer**.

**Migration E — `20261130000000_phase7a_transport`:**
1. **`transport_vehicle` (soft delete):**
   - Columns: registration_no varchar(15) (canonical: upper, no spaces / hyphens), label varchar(40), kind (BUS / MINIBUS / VAN / CAR / OTHER), seating_capacity smallint CHECK 1–100, ownership (OWNED / CONTRACTED), contractor_name varchar(120) NULL, status (ACTIVE / OUT_OF_SERVICE / RETIRED).
   - Partial unique (registration_no) WHERE deleted_at IS NULL.
2. **`vehicle_document`:**
   - Columns: vehicle_id, type (RC / INSURANCE / FITNESS / PERMIT / PUC / ROAD_TAX / OTHER), label varchar(60) NULL (required for OTHER — CHECK), number varchar(40) NULL, issued_on, expires_on NULL, file_id unique → stored_file RESTRICT (PRIVATE, purpose `transport.vehicle_document`), superseded_at NULL, deleted_at.
   - Partial unique (vehicle_id, type) WHERE superseded_at IS NULL AND deleted_at IS NULL AND type <> 'OTHER'.
   - Partial index (expires_on) WHERE superseded_at IS NULL AND deleted_at IS NULL.
   - `school_setting.features.transport.mandatoryDocTypes` (JSON, no migration).
3. **`transport_crew`:**
   - Columns: role (DRIVER / CONDUCTOR / ATTENDANT), employee_id unique NULL → employee, external_name varchar(120) NULL, external_phone varchar(10) NULL, agency varchar(120) NULL, licence_no varchar(20) NULL (canonical), licence_expires_on NULL, licence_file_id unique NULL, is_active.
   - CHECKs:
     - exactly one of employee_id / external_name;
     - external_phone only with external_name;
     - DRIVER ⇒ licence_no AND licence_expires_on.
   - Partial unique (licence_no) WHERE licence_no IS NOT NULL AND is_active.
   - Partial index (licence_expires_on) WHERE is_active.
4. **`transport_fare_slab`:**
   - Columns: academic_session_id, name, name_key, amount numeric(12,2) CHECK ≥ 0, one_way_amount numeric(12,2) NULL CHECK ≥ 0, is_active.
   - U(session, name_key); U(id, session).
5. **`transport_route`:**
   - Columns: academic_session_id, code varchar(20), name, vehicle_id NULL, driver_crew_id NULL, attendant_crew_id NULL, seat_cap smallint NULL CHECK ≥ 1, is_active.
   - U(session, code); U(id, session).
   - The `seat_cap ≤ vehicle seats` check lives in the service (cross-table).
6. **`transport_stop`:**
   - Columns: route_id + academic_session_id (composite FK to the route), name varchar(80), sequence smallint, pickup_time time NULL, drop_time time NULL, fare_slab_id + academic_session_id (composite FK to the slab), is_active.
   - U(route_id, sequence) **DEFERRABLE INITIALLY IMMEDIATE** (reordering in one transaction); U(id, route_id) as the target for the allocation FK.
   - No coordinates (O36).
7. **`student_transport` (allocation):**
   - Columns: student_id + academic_session_id → student_enrollment (student, session), route_id + academic_session_id → route, (stop_id, route_id) → stop U(id, route_id), mode (BOTH / PICKUP / DROP), start_on, end_on NULL, status (LIVE / ENDED), ended_reason varchar(200) NULL, created_by_id, ended_by_id, ended_at, version.
   - CHECKs: end_on ≥ start_on; ENDED ⇔ end_on AND ended_at.
   - **Partial unique (student_id, academic_session_id) WHERE status = 'LIVE'.**
   - Index (route_id, status).
   - Non-overlap of a student's ENDED and LIVE windows: enforced in the service under the student lock (no btree_gist extension).

   No `student_fee_charge` change: TRANSPORT + `source_ref = allocation id` already exists.

**No migration for 7A's staff inbox:** `notification` already has type, link and dedupe key; the link scheme is code.

**Migration F — `20261201000000_phase7b_library`:**
8. **`library_book` (soft delete):**
   - Columns: title varchar(200), title_key (normalized, for search), authors varchar(300), publisher varchar(120) NULL, edition varchar(40) NULL, year smallint NULL, isbn varchar(13) NULL (canonical; indexed, **not unique** — editions and reprints), subject varchar(80) NULL, language varchar(30) NULL, call_no varchar(30) NULL.
   - Indexes: (title_key), (isbn).
9. **`library_copy`:**
   - Columns: book_id, accession_no varchar(20) unique, status (AVAILABLE / ISSUED / LOST / DAMAGED / WITHDRAWN), acquired_on NULL, source (PURCHASE / DONATION / OTHER), price numeric(12,2) NULL CHECK ≥ 0, withdrawn_reason varchar(200) NULL.
   - Index (book_id, status).
10. **`library_loan`:**
    - Columns: copy_id, borrower_kind (STUDENT / EMPLOYEE), student_id NULL, employee_id NULL, academic_session_id (session at issue; rule 8), issued_on, due_on, returned_on NULL, renewals smallint DEFAULT 0, issued_by_id, returned_by_id.
    - CHECKs: borrower columns ⇔ kind; due_on ≥ issued_on; returned_on ≥ issued_on.
    - **Partial unique (copy_id) WHERE returned_on IS NULL.**
    - Partial indexes: (student_id), (employee_id) and (due_on), each WHERE returned_on IS NULL.
11. **`library_fine`:**
    - Columns: loan_id, kind (OVERDUE / LOST / DAMAGED), amount numeric(12,2) CHECK > 0, status (OPEN / CHARGED / WAIVED / SETTLED), fee_charge_id unique NULL → student_fee_charge, waived_by_id, waive_reason varchar(300) NULL, settled_note varchar(200) NULL (staff, O11), version.
    - U(loan_id, kind).
    - CHECKs: CHARGED ⇔ fee_charge_id; WAIVED ⇒ reason and waived_by.
12. **`FeeChargeSource` + `LIBRARY`** (`ALTER TYPE … ADD VALUE`; the new value can't be used in the same transaction — do it as the migration's first statement or its own migration) + **partial unique (source_ref) WHERE source = 'LIBRARY' AND deleted_at IS NULL** on `student_fee_charge` (one charge per fine).

Settings JSON (no migration): `library: { loanRules: {STUDENT|EMPLOYEE: {maxOpen, loanDays, renewals}}, fines: {perDay, graceDays, cap, staffFines} }`; idFormats `libraryAccession`.

**Migration G — `20261202000000_phase7c_certificates`:**
13. **`certificate`:**
    - Columns: type (BONAFIDE / CHARACTER / TRANSFER), copy_kind (ORIGINAL / DUPLICATE), duplicate_of_id NULL self-FK, student_id + academic_session_id → student_enrollment, serial_no varchar(40) NULL, status (DRAFT / ISSUING / ISSUED / CANCELLED), fields jsonb (entered values), snapshot jsonb NULL, document_id unique NULL → generated_document RESTRICT, prepared_by_id, prepared_at, issued_by_id, issued_at, cancelled_by_id, cancelled_at, cancel_reason varchar(300), clearance_ack boolean NULL, print_count int DEFAULT 0, version, deleted_at (DRAFT only hard-deleted).
    - CHECKs:
      - ISSUING / ISSUED / CANCELLED-after-issue ⇒ serial_no;
      - ISSUED ⇒ snapshot, document_id, issued_by, issued_at;
      - CANCELLED ⇒ reason;
      - DUPLICATE ⇔ duplicate_of_id;
      - **TRANSFER ⇒ issued_by_id ≠ prepared_by_id**;
      - snapshot is an object.
    - Partial uniques:
      - **(type, serial_no) WHERE copy_kind = 'ORIGINAL' AND serial_no IS NOT NULL**;
      - **(student_id) WHERE type = 'TRANSFER' AND copy_kind = 'ORIGINAL' AND status <> 'CANCELLED' AND deleted_at IS NULL**.
    - Index (type, issued_at).

Settings: idFormats `certBonafide`, `certCharacter`, `certTransfer`; `features.certificates.tcRequiresClearance` (default false).

**Migration H — `20261203000000_phase7d_inventory`:**
14. **Master tables:**
    - `inventory_category`: name, name_key unique, kind (CONSUMABLE / ASSET), is_active;
    - `inventory_location`: name, name_key unique, kind (STORE / ROOM / LAB / OFFICE / OTHER), is_active;
    - `inventory_vendor`: name, name_key unique, phone NULL, gstin varchar(15) NULL, is_active.
15. **`inventory_item` (consumable, soft delete):** category (kind CONSUMABLE — service), name, name_key unique, unit varchar(12), reorder_level int NULL CHECK ≥ 0.
16. **`inventory_stock`:** PK (item_id, location_id), quantity int NOT NULL **CHECK ≥ 0**, version, updated_at.
17. **`inventory_movement`:**
    - Columns: item_id, location_id, kind (RECEIPT / ISSUE / TRANSFER_OUT / TRANSFER_IN / ADJUSTMENT / WRITE_OFF / REVERSAL), quantity int CHECK ≠ 0, balance_after int CHECK ≥ 0, unit_cost numeric(12,2) NULL (RECEIPT only — CHECK), vendor_id NULL, issued_to_employee_id NULL, issued_to_text varchar(80) NULL, reference varchar(40) NULL, reason varchar(300) NULL (required for ADJUSTMENT / WRITE_OFF / REVERSAL — CHECK), reverses_id unique NULL self-FK, transfer_group_id NULL, occurred_on date, actor_id, created_at. **No updated_at:** append-only (documented exception to the convention).
    - CHECK sign by kind (RECEIPT / TRANSFER_IN > 0; ISSUE / TRANSFER_OUT / WRITE_OFF < 0).
    - Indexes: (item_id, created_at), (occurred_on).
18. **`asset` (soft delete only before history exists):**
    - Columns: asset_tag varchar(30) unique, category_id (kind ASSET), name, make_model varchar(120) NULL, serial_no varchar(60) NULL, purchased_on NULL, purchase_cost numeric(12,2) NULL, vendor_id NULL, warranty_until NULL, location_id, custodian_employee_id NULL, status (IN_STORE / IN_USE / UNDER_REPAIR / LOST / DISPOSED), condition varchar(40) NULL.
    - Indexes: (status), (location_id).
19. **`asset_event`** (append-only history of location / custodian / status changes): asset_id, kind, from / to ids, occurred_on, actor_id, note varchar(200).
20. **`asset_maintenance`:** asset_id, kind (REPAIR / SERVICE / AMC / INSPECTION), opened_on, closed_on NULL, vendor_id NULL, cost numeric(12,2) NULL CHECK ≥ 0, description varchar(500), next_due_on NULL, status (OPEN / CLOSED). Partial index (next_due_on) WHERE next_due_on IS NOT NULL.
21. **`asset_disposal`:**
    - Columns: asset_id, method (SOLD / SCRAPPED / DONATED / LOST / RETURNED), reason varchar(300), amount_recovered numeric(12,2) NULL CHECK ≥ 0, status (PROPOSED / APPROVED / REJECTED), proposed_by_id, proposed_at, decided_by_id, decided_at, decision_note varchar(300) NULL.
    - CHECKs: **decided_by ≠ proposed_by**; decided fields ⇔ status ≠ PROPOSED.
    - **Partial unique (asset_id) WHERE status IN ('PROPOSED','APPROVED')**.

Settings: idFormats `assetTag`.

**Migration I — `20261204000000_phase7e_records_events`:**
22. **`school_document` (soft delete):**
    - Columns: category (AFFILIATION / RECOGNITION / NOC / SAFETY / INSURANCE / REGISTRATION / POLICY / LEGAL / OTHER), label varchar(80) NULL (OTHER), title varchar(150), reference_no varchar(60) NULL, authority varchar(120) NULL, issued_on NULL, valid_from NULL, expires_on NULL, confidential boolean DEFAULT false, file_id unique → stored_file (PRIVATE, purpose `school.document`), supersedes_id unique NULL self-FK, status (CURRENT / SUPERSEDED / ARCHIVED).
    - Partial index (expires_on) WHERE status = 'CURRENT' AND deleted_at IS NULL.
23. **`school_event`:**
    - Columns: academic_session_id, title varchar(120), kind (MEETING / PTM / CELEBRATION / SPORTS / TRIP / EXAM_DUTY / OTHER), starts_on, ends_on, start_time NULL, end_time NULL, venue varchar(120) NULL, details varchar(2000) NULL, in_charge_employee_id NULL, status (SCHEDULED / CANCELLED), cancelled_reason NULL.
    - CHECK ends_on ≥ starts_on. Index (academic_session_id, starts_on).
24. **`event_duty`:** PK (event_id, employee_id), duty varchar(120), notified_at NULL.

**Imports (7F):** no migration. Legacy numbers fit the existing `admission_no` / `employee_code` varchar(32) unique columns; check that the formats in use never produce an imported value (service).

**Docs in the same changes:** DATABASE_SCHEMA (§9 / §11 rewritten + new sections), DATABASE_RELATIONSHIPS, the `db:check` table list, and the module map in SYSTEM_ARCHITECTURE §3.

---

## 6. Milestones

| Milestone | Content | Integration acceptance (real DB) / gate |
|---|---|---|
| **7-M0** | Owner decisions O1–O37, §10 questions. Not dependent on 6C-M5 | Owner |
| **7A-M1** | Migration E + guard test. **Whole Phase 7 catalog change** (§4) + seed + RBAC_MATRIX. Pure `transport-rules.ts` (registration / licence canonicalisation, expiry state, billable installments for a window, seat count per direction). Transport settings schema (Zod, `features.transport`) | Unit: rules truth tables (due-date boundary in the school time zone, end before start, one-way fare). SQL approval → development → Test; catalog sync approval |
| **7A-M2** | Vehicles (CRUD, retire), vehicle documents (upload route like KI-048, supersede, download via `GET /api/v1/files/:id` purpose rule), crew (employee or external, licence masked), transport dashboard with a live "expiring" panel. ERP `/erp/transport/*` mobile-first | Registration-number duplicate (canonical forms) refused; one current document per type; supersede keeps history; expired / expiring panel correct at the threshold days; licence number masked for `transport.read`, full for `transport.manage`; audit has no licence number; crew employee must be ACTIVE NON_TEACHING; RBAC 403 per role. **Security review (uploads)** |
| **7A-M3** | Staff inbox (`notifications.staff.ts`, `/erp/inbox`, header bell, mark read), `identity/permission-holders.tx.ts`, daily alerts step in the cron route (vehicle documents, crew licences) | One alert per document per threshold (re-run no duplicate); portal accounts never receive staff drafts; a user who lost `transport.read` no longer sees the row; a portal key never renders in the ERP and vice versa (unit); cron without `CRON_SECRET` 401; bounded query counts. **Security review (notifications, cron)** |
| **7A-M4** | Fare slabs, routes, stops (reorder), allocation create / change / end with seat check, `fees/charges-sync.tx.ts` (`syncTransportChargesTx`), student "Transport" tab, route manifest print view (guardian primary phone per O33 / FC20 precedent; no DOB) | **Route capacity:** 41 parallel allocations to a 40-seat route → exactly 40, the rest a clear conflict; per-direction counting; stop change across two full routes, no deadlock (both orders in parallel); smaller vehicle refused. **Fees:** charges only for un-invoiced installments in the window; end mid-session drops only un-invoiced charges; issued invoice / receipt rows byte-identical before and after (snapshot compare); re-sync idempotent; `cancelInvoice` then re-sync consistent; fare change preview = applied; `removeCharge` still refuses TRANSPORT. Rolled-back allocation writes no charge. **Security review (fees integration)** |
| **7A-M5** | Next-session rollover (preview → confirm), leavers-still-allocated list, reports: route / stop counts, seat utilization, expiring documents, **transport-charge reconciliation** (every LIVE allocation × un-invoiced billable installment has one charge; every live TRANSPORT charge has a covering allocation) + CSVs | Rollover capacity-checked, idempotent; promoted only; reconciliation clean after a simulated term; CSV redaction and formula safety; audit filters and row count only |
| **7A-M6** | Verification on Test (needs KI-059), e2e at 360 / 768 / 1280 (allocate a student, see the charge on the counter), axe clean | Owner sign-off |
| **7B-M1** | Migration F (incl. the `LIBRARY` enum value + partial unique), pure `library-rules.ts` (fine calc: grace, per day, cap, school-time-zone days; due dates; renewal eligibility), library settings | Unit truth tables. SQL approval → development → Test |
| **7B-M2** | Catalogue: books, copies (accession from the sequence, `ensureSequenceAtLeast` seeding), withdraw, search (title_key prefix / ILIKE, `take` 50), copy labels list (print view) | Accession numbers consecutive under 20 parallel creates; seeding only raises; withdraw refused while issued |
| **7B-M3** | Desk: issue (1..n copies) / return / renew by accession number (one-handed, 360 px), borrower limits, overdue list | **Loan invariants:** 2 desks issuing one copy at the same instant → one loan; a borrower at limit − 1 issued 2 books at 2 desks → limit respected; return twice → second refused; `library.read` holders don't see borrower names; Student SELF refused |
| **7B-M4** | Fines: on return, lost / damaged with replacement charge, waive (before invoicing), post to fees (`addLibraryChargeTx` → next un-invoiced installment; else OPEN), staff fines per setting (SETTLED note), fines register | One charge per fine (re-run safe); waiver after invoicing refused; fine amounts audited, notes not; rolled-back return writes no charge; charge description = category name only (no title). **Security review (money into fees)** |
| **7B-M5** | Reports (overdue, issue register, fines, accession register, stock verification sheet) + CSV (`export.run` holders); overdue alert to the Librarian in the daily step; verification on Test, e2e 360 | Owner sign-off |
| **7C-M1** | Migration G; `lib/sequence.ensureSequenceAtLeast` (unit + integration); documents split (`prepareIssuedDocument` / `recordIssuedDocumentTx`, `issueDocument` rewired, allowlist source-scan test); certificate format settings (lock after first issue); pure `certificate-rules.ts` (status machine, TC prerequisites, field whitelist per type) | `issueDocument` behaviour unchanged (existing tests); allowlist test fails on a new caller. SQL approval |
| **7C-M2** | Bonafide and character: prepare (draft), issue (transaction 1 serial → render → transaction 2 store), download (`documentPdf` limit, audited view), cancel, duplicate; certificate register | **Certificate serials:** 20 parallel issues → 20 distinct consecutive serials; a render failure leaves ISSUING and "finish" completes with the same serial; a rolled-back transaction 1 consumes no number; no format → refused; cancelled keeps the number; duplicate has the same serial and the original fails verification; verification code never in audit or logs |
| **7C-M3** | TC: leaving-status prerequisite, clearance panel (`fees/outstanding.tx`, `library.openLoansOfStudentTx`, `transport.liveAllocationOfTx`), acknowledgement, maker-checker, one live original | Issuer = preparer refused (Super Admin too); a second TC refused while one is live; amount hidden from non-`fee.read` issuers (asserted on serialized output); `tcRequiresClearance` on → blocked with dues; ACTIVE student refused |
| **7C-M4** | Public `/verify` (fragment → POST), `hitLocal` + DB limiter + LRU cache, minimal response; KI-037 closed | Malformed code → no DB query (spy); the 21st request in 10 min → 429 before the DB; response contains no name / ID (asserted); revoked → "revoked"; cache doesn't serve a revoked document as valid beyond 5 min (documented; revocation clears the cache entry in-process). **Security review (public endpoint, documents)** |
| **7C-M5** | Verification on Test, e2e 360 (prepare → issue → download → verify) | Owner sign-off |
| **7D-M1** | Migration H; pure `stock-rules.ts` (sign by kind, reversal, transfer pairing) | SQL approval |
| **7D-M2** | Categories, locations, vendors; consumables receive / issue / transfer / adjust / write-off / reverse; stock card; low-stock panel + daily alert | **Stock invariants:** 20 parallel issues of 1 against stock 10 → exactly 10 succeed, on-hand 0, never negative, Σ movements = on-hand; parallel transfers A→B and B→A, no deadlock and conservation of totals; double reversal refused; reconciliation query clean after a random mixed run (seeded) |
| **7D-M3** | Assets: register (tag sequence + seeding), move / assign custodian (history), maintenance (next due → daily alert), disposal maker-checker | Self-approval refused (Super Admin too); one live disposal per asset; DISPOSED is final; tags consecutive under parallel creates |
| **7D-M4** | Reports (stock on hand, movement register, asset register, maintenance due, disposals) + CSV; verification on Test; e2e 360 | Owner sign-off |
| **7E-M1** | Migration I | SQL approval |
| **7E-M2** | School documents register: upload (route like KI-048, purpose `school.document`), supersede, archive, confidential flag, expiry panel + daily alert | Confidential row → NotFound for `schooldoc.read` without manage (list and file); supersede chain; alerts deduped. **Security review (uploads, confidential)** |
| **7E-M3** | Internal events + duties (`events` module), staff inbox notification on duty assignment (after commit), "My duties" card on the ERP dashboard | Cancelled event notifies once; duty for a non-ACTIVE employee refused; portal reads unchanged (calendar suites untouched); staff-only by construction (no portal function exists — source-scan) |
| **7E-M4** | Verification on Test, e2e 360 | Owner sign-off |
| **7F-M1** | `lib/import/flow.ts` (pure). **Student import** (existing students): template, preview (section capacity, duplicate admission no., in-file duplicates, guardian phones), confirm through `registration.ts` under the approval's locks; legacy admission numbers (O32) | 500-row file in one transaction within 60 s on Test; re-upload → all skipped; capacity respected under a parallel admission; counter raised past legacy max; audit has ids only. **Security review (bulk PII)** |
| **7F-M2** | **Staff import** through `employees.service` (legacy employee codes per O32; no PAN / bank columns) | Same pattern; personal-tier columns only with `employee.personal.read` |
| **7F-M3** | Operational imports: library catalogue + copies (legacy accession), inventory opening stock (RECEIPT movements "opening") + asset register, transport allocations (capacity per row, fees sync per student) | Idempotent re-runs; opening stock = file; allocation import respects capacity and writes charges like single allocations |
| **7F-M4** | **Export gate audit** (a source-scan + RBAC test enumerating every `api/v1/**/export` route and proving each requires its domain read at ALL; Transport Manager can export only transport reports), "Reports" hub page, certificates register CSV, the remaining reports index | **Export redaction:** for every new CSV, column whitelist per caller (licence number only with `transport.manage`; guardian phone only on manifests; no DOB, address, staff personal phone, confidential school documents); formula injection neutralised; > 5,000 rows refused. **Security review (exports)** |
| **7F-M5** | Phase 7 verification on Test (all suites), closure report, docs | Owner sign-off |
| **7G (optional)** | Starts only after **6C-M5** is closed. Portal transport card and library card (`*.portal.ts`, `assertPortalStudent`), catalog `transport.read` C/S + `library.read` C, IDOR rows | Full IDOR suite rows; security review |

**Planned file layout:**
- `src/modules/transport/{transport-rules,transport.policy,vehicles.service,vehicle-documents.service,crew.service,routes.service,allocations.service,rollover.service,transport-reports.service,transport.alerts,transport.tx,*.schemas}.ts`
- `src/modules/fees/{charges-sync.tx,outstanding.tx}.ts`
- `src/modules/library/{library-rules,library.policy,catalogue.service,loans.service,fines.service,library-reports.service,library.alerts,library.tx,*.schemas}.ts`
- `src/modules/inventory/{stock-rules,inventory.policy,setup.service,stock.service,assets.service,disposals.service,inventory-reports.service,inventory.alerts,*.schemas}.ts`
- `src/modules/certificates/{certificate-rules,certificates.policy,certificates.service,clearance.ts,*.schemas}.ts`
- `src/modules/documents/templates/certificate-{bonafide,character,transfer}.tsx`
- `src/modules/schooldocs/*`, `src/modules/events/*`
- `src/modules/notifications/notifications.staff.ts`, `src/modules/identity/permission-holders.tx.ts`
- `src/lib/import/flow.ts`, `src/lib/sequence.ts` (+ `ensureSequenceAtLeast`)
- `src/app/erp/{transport,library,inventory,certificates,school-documents,events,inbox,reports}/**`
- `src/app/(public)/verify/*`
- upload and export routes under `src/app/api/v1/**`

Visual specs (desk screen, allocation flow, stock card, certificate preview, inbox) come from **ui-ux-designer**.

---

## 7. Tests (required)

**Roadmap-mandated:**
1. **Stock invariants under concurrency** (7D-M2): parallel issues, transfers in both directions, reversals; on-hand = Σ movements; CHECK ≥ 0 never violated (the DB error is mapped, never leaked).
2. **Route capacity** (7A-M4): parallel allocations at the seat limit, per direction, stop changes across full routes, vehicle swap.
3. **Certificate serials** (7C-M2 / M3): consecutive under concurrency, gap-free on rollback, ISSUING recovery, duplicate same serial, cancel keeps the number, one live TC, `ensureSequenceAtLeast` never lowers.
4. **Export redaction** (7F-M4 + each module's CSV): column whitelists per permission, gate audit across all export routes, formula safety, caps, audit content.

**Also:**
- **Loan invariants:** one open loan per copy, borrower limit under two desks.
- **Fees integration:** issued invoices and receipts unchanged (row snapshot before / after); idempotent syncs; the reconciliation reports for transport and fines.
- **RBAC:**
  - every new action, page and route: forbidden roles → 403 / not-permitted;
  - portal accounts redirected (extend `tests/unit/portal-rbac.test.ts`);
  - maker ≠ checker (TC, disposals; Super Admin included);
  - writes at non-ALL scopes refused.
- **Unit:**
  - transport-rules, library-rules (fines), stock-rules, certificate-rules;
  - `lib/import/flow`; canonicalisation (registration, licence, ISBN, accession);
  - the documents caller allowlist;
  - staff / portal notification key separation;
  - static guards: no Phase 7 module imported by students / HR / fees (check:deps + test); no `/portal` code imports Phase 7 modules before 7G.
- **E2E (Playwright 360 × 800 + 768 / 1280, axe clean):**
  - allocate a student and see the charge at the counter;
  - issue and return a book with a fine;
  - prepare → issue → download → verify a bonafide certificate;
  - TC with the clearance warning;
  - stock issue;
  - asset disposal approval;
  - upload a vehicle document and see the expiry alert in the inbox;
  - import a student file (preview → confirm).
- **Budget:** daily alerts step query count asserted (≤ 2 per module); `/verify` makes no DB query for malformed codes or above the local limit.

---

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Transport and library change issued invoices or receipts (financial integrity) | Fees-owned sync touching only un-invoiced charges; issued-row snapshot tests; `removeCharge` refusal kept; security review 7A-M4 / 7B-M4 |
| R2 | Overbooked buses (child safety) | Hard capacity under the route lock, no override, leavers excluded, tests |
| R3 | Expired insurance / fitness unnoticed | Dashboard panel + daily in-app alerts at 30 / 7 / 0 days; mandatory types per school; no email / SMS by policy (documented limit) |
| R4 | Certificate forgery or duplicate serials | HMAC verification codes (ADR-031), public verify page, gap-free serials, one live TC, maker-checker, revocation on cancel / duplicate |
| R5 | TC withheld unlawfully, or issued with dues unknowingly | Warn-not-block default, visible clearance panel, acknowledgement, school confirms its legal position (O22) |
| R6 | Stock drift / negative stock | Row locks + CHECK ≥ 0 + append-only movements + reconciliation; KI-106 noted (role can bypass) |
| R7 | Lock contention on the global `lockFeeSetup` (allocation days, invoice runs) | Short transactions, `lock_timeout` 5 s → "busy, retry"; bulk rollover batched ≤ 200; measured on Test |
| R8 | Personal data leaks in operations lists (guardian phones, licence numbers, staff phones) | Column whitelists, print views without CSV, licence masking, export gate audit, no DOB / address in manifests |
| R9 | **Non-Latin text on certificates** (KI-051) | Templates WinAnsi-only today; a bundled Unicode font is a separate dependency / licence review (question 6); until then names must be entered in Latin script for PDFs |
| R10 | Public `/verify` hammered (Neon compute, enumeration) | Local limiter before the DB, malformed codes rejected offline, LRU cache, ~60-bit codes (ADR-031) |
| R11 | Legacy import collisions (admission no. / accession / tags) | Verbatim import + monotonic counter raise + a format-collision check; preview shows collisions; all-or-nothing per file |
| R12 | Scope creep (GPS, fuel, depreciation, ad-hoc invoices, transport concessions, ID cards) | O17, O26, O36, O37 + §9 |
| R13 | Touching unverified Phase 5 / 6 code | No portal read changes; the notifications portal path untouched; fees changes limited to two new `*.tx` files + enum value; re-run fees suites with every fees-touching milestone (when KI-059 allows) |
| R14 | Verification debt (KI-059) | No milestone closes with unrun suites; offline unit coverage maximised |

**KIs to open:**
- transport concessions (O37);
- ad-hoc invoices for fines / certificate fees (O26);
- fine waiver after invoicing;
- staff transport (O9);
- vehicle service / fuel logs, GPS (O36);
- depreciation (O17);
- QR codes (O25);
- editable certificate wording (O24);
- barcode labels / scanning;
- ID cards (Phase 2 deferral, still open);
- Unicode PDF fonts (KI-051 follow-up);
- 7G portal exposure.

---

## 9. Out of scope (Phase 7)

- GPS / live bus tracking, maps, route optimisation; SMS / WhatsApp / email alerts (in-app only).
- Vehicle service and fuel logs; staff transport; transport concessions.
- Library: barcode label printing, RFID, OPAC for the public, e-books, inter-library loans, reservations / holds (KI).
- Inventory: valuation, depreciation, purchase orders / indents, GST accounting, vendor payments (no accounting — FC21).
- Certificates beyond bonafide / character / TC (migration, conduct-for-exam, sports); certificate requests by parents (portal); student ID cards.
- Public CMS events and downloads (Phase 8); family-visible changes to the academic calendar.
- The generic ImportJob pipeline; XLSX exports (CSV only); scheduled report emails.

---

## 10. Questions for the school (missing requirements)

1. How many buses / vans, routes and transport students? Are any vehicles or drivers contracted (an agency's staff)?
2. How is transport charged today: by distance slab, by stop, or flat? Monthly with tuition? Is there a one-way rate? Any staff-ward or sibling transport concessions?
3. Which vehicle documents does the school track, and which must never lapse? Who should be alerted?
4. Is a student who starts transport mid-month charged for that month?
5. **The board and its TC format** (e.g. CBSE), plus samples of the school's current bonafide, character and transfer certificates. Who signs each? Are TCs from a pre-printed numbered book, and what is the last number used for each type?
6. Must certificates (or names) be printed in Hindi or a regional script?
7. Does the school withhold TCs for unpaid dues today? Has it taken advice on the applicable state rule?
8. Library size (titles / copies), existing accession register format, barcode labels? Loan period, number of books per student / staff, renewals, fine per day and cap? Do staff pay fines?
9. Should fines and lost-book charges appear on the fee invoice, or be collected some other way?
10. Inventory: which consumables are tracked (stationery, lab, cleaning), in which units and stores? Who keeps the store? Which assets need tags, and does the school already have tag numbers? Who approves disposal?
11. Which institutional documents (affiliation, recognition, fire NOC, building safety, water testing, insurance…) should be tracked, and who should see confidential ones (land, legal)?
12. Which internal events need duty rosters (exam invigilation, PTM, sports day, trips)?
13. For go-live: in what form are the existing student and staff lists available (Excel?), and must existing admission numbers and employee codes be kept?
14. Should parents see transport details and library loans in the portal later (7G)?

---

## 11. Security checklist (Phase 7-specific)

- **Authorization:**
  - every service calls `authorize` at ALL for writes;
  - Phase 7 modules never widen `students.policy`; student lookups for transport / library / certificates go through minimal-field students `*.tx` helpers after the caller's own permission check;
  - NotFound for out-of-scope or confidential records (no existence oracle).
- **Financial integrity:**
  - only fees writes `student_fee_charge`;
  - invoiced rows are never touched;
  - amounts audited for charges (L4 precedent), never in notifications;
  - no new cash point.
- **Maker-checker:** TC issuer ≠ preparer, disposal decider ≠ proposer — CHECKs plus service checks, Super Admin included.
- **Sequences:**
  - all numbers from `lib/sequence`, taken last in the transaction;
  - `ensureSequenceAtLeast` only raises, needs `settings.manage` (or the importing permission inside the import transaction), audited;
  - format edits locked after first use (KI-104 rule).
- **Documents:**
  - module-issued PDFs always PRIVATE;
  - verification codes never stored, logged, audited or put in a query string (fragment + POST);
  - the caller allowlist test;
  - revocation on cancel / duplicate;
  - PDFs `private, no-store`, attachment, non-identifying filename, `documentPdf` limit.
- **Public `/verify`:** `hitLocal` before the DB, offline rejection of malformed codes, minimal response without PII, cache invalidated on revoke (same process), CSP unchanged (no third-party origins).
- **Uploads** (vehicle documents, licence scans, school documents):
  - `lib/storage` only, purpose rules (magic bytes, ≤ 10 MB, PDF / JPEG / PNG, metadata stripped, encrypted);
  - dedicated upload routes (KI-048 pattern: same-origin, session, rate limit, hard body cap);
  - downloads through the authorized file route with an owner + purpose check;
  - confidential school documents need `schooldoc.manage`.
- **Personal data:**
  - licence numbers masked except for `transport.manage`, never in audit or alerts;
  - crew contact = work phone (employees) or the agency-provided phone (external);
  - manifests: name, class / section, stop, primary guardian phone only (no DOB / address);
  - no Aadhaar / medical (not collected);
  - notification bodies carry no names of students or amounts (e.g. "Insurance for KA01AB1234 expires in 7 days" — a registration number is not personal data).
- **Exports:** export gate audit test; column whitelists; formula-safe; ≤ 5,000 rows; audited filters + count; Transport Manager's `export.run` proven not to unlock other exports.
- **Imports:**
  - in memory only, `tabular` limits, all-or-nothing, through services (no raw inserts);
  - no sensitive columns accepted (PAN / bank / Aadhaar refused in templates);
  - preview and confirm rate limited;
  - audit ids only.
- **Notifications:** staff and portal paths separate (links, recipients, key prefixes); permission re-check at read; no polling.
- **Cron:** `CRON_SECRET`, idempotent, bounded, no PII in logs.
- **Escalation to security-auditor:** 7A-M2 (uploads), 7A-M3 (notifications, cron), 7A-M4 (fees), 7B-M4 (fines into fees), 7C-M4 (public verify + documents path; also review 7C-M2 / M3 serials and maker-checker), 7E-M2 (uploads, confidential), 7F-M1 (bulk PII import), 7F-M4 (exports).

---

## 12. ADRs to record (SYSTEM_ARCHITECTURE §2; last is ADR-048)

| ADR | Decision | Rationale | Rejected |
|---|---|---|---|
| **ADR-049** | **Transport fees = TRANSPORT `StudentFeeCharge` rows kept in sync by a fees-owned `syncTransportChargesTx`** (due-date rule, no proration, un-invoiced installments only, `sourceRef` = allocation); fare slabs per session | Reuses the FC18 hook; receipts and issued invoices are never written; one collection path | A separate transport invoice; structure lines per class; day proration |
| **ADR-050** | **Module-authorized document issuing:** `documents.prepareIssuedDocument` + `recordIssuedDocumentTx`, with authorization by the calling module; allowlisted callers (source-scan test); `issueDocument` remains the `document.generate` wrapper | Certificates (and later KI-089 / 090 / 099) need verifiable PDFs under their own permissions; rendering stays outside transactions | Granting `document.generate` to issuers; per-module copies of the registry logic |
| **ADR-051** | **Certificates module:** one serial series per type from `lib/sequence`, assigned at issue (ISSUING → ISSUED, retry with a fresh code), cancelled keep numbers, duplicate = same serial + original revoked, one live original TC, TC maker-checker, warn-not-block clearance; `ensureSequenceAtLeast` (monotonic raise) to continue paper registers | Gap-free, auditable numbering; recoverable PDF failures; legal neutrality on dues | Serial at draft (gaps on discarded drafts); rendering inside the transaction; hard dues block |
| **ADR-052** | **Public verification page `/verify`:** fragment → POST, in-process limiter before the DB, offline rejection of malformed codes, 5-minute in-process cache, minimal answer (type, serial, date, status) | Closes KI-037 within the Neon free-tier and enumeration constraints | A query-string code; DB-backed limiting only; showing student details |
| **ADR-053** | **Inventory is count-only with an append-only movement ledger** and a per (item, location) on-hand row (CHECK ≥ 0) updated under ordered row locks; corrections by reversal; assets tracked individually with maker-checker disposal; no valuation or depreciation | Provable invariants under concurrency; matches the school's need without accounting scope | Quantity-only rows without a ledger; FIFO / WAC valuation; depreciation |
| **ADR-054** | **Library loans:** one open loan per copy (partial unique), borrower advisory lock for limits; student fines become LIBRARY fee charges (fees-owned) | No second cash point or receipt series; DB-enforced copy exclusivity | Cash fines at the desk; counter columns on books (`availableCopies`) |
| **ADR-055** | **Staff in-app inbox:** `notifications.staff` beside the portal path (`/erp/` links, staff-only recipients, staff key prefixes, permission re-check at read), with a daily alert step in the existing cron | Expiry and duty alerts without email / SMS or polling; Phase 6 portal delivery untouched | Reusing the portal deliver path; a separate alerts table; polling |
| **ADR-056** | **Imports stay in memory per module** (template → preview → confirm, ≤ 500 rows per file, one transaction, through services); the generic ImportJob pipeline is not built. **Legacy identifiers** (admission no., employee code, accession no., asset tag) are imported verbatim, and the counters are raised with `ensureSequenceAtLeast` | Proven pattern (ADR-039, FC19), no staging data in the 512 MB budget, no worker; schools keep their existing numbers | Staged ImportJob / ImportRow with a worker; regenerating legacy numbers |
| **ADR-057** | **Internal events (`events`) and the institutional records register (`schooldocs`) are their own staff-only modules;** the family-visible academic calendar is unchanged | Staff-only by construction; no change to unverified portal reads | A visibility flag on `AcademicEvent`; reusing CMS Event / Download |

Module-map updates in the same change:
- `transport` (models as in §5; depends on students, hr, fees, identity, files, settings, notifications);
- `library`;
- `inventory`;
- new `certificates`, `schooldocs`, `events`;
- `importexport` marked "not built (ADR-056)".

---

## 13. Completion criteria

1. Every 7A–7F integration suite is green on Neon Test, including the four roadmap tests (stock invariants under concurrency, route capacity, certificate serials, export redaction) and the fees regression suites.
2. The e2e journeys pass at 360 / 768 / 1280 px with axe clean.
3. The RBAC matrix is regenerated, and the catalog sync (94 / 13 / 335, or as decided) is applied to development and Test with approval.
4. Security reviews are done at every gate in §11.
5. The transport-charge and fines reconciliation reports are clean after a simulated term on Test.
6. `lint`, `typecheck`, `check:deps` and `test` all pass; CI is green.
7. Docs are updated:
   - DATABASE_SCHEMA, DATABASE_RELATIONSHIPS;
   - SYSTEM_ARCHITECTURE (ADR-049…057, module map);
   - AUTHENTICATION_AND_RBAC + RBAC_MATRIX;
   - SECURITY;
   - API_DOCUMENTATION (upload, export, verify routes);
   - UI_UX_GUIDELINES (desk screens, inbox);
   - FREE_TIER (daily alerts, verify cache);
   - ENVIRONMENT_VARIABLES (no new secrets expected);
   - the import-export skill (ADR-056);
   - CLAUDE.md (PDF installed; import note);
   - DEVELOPMENT_ROADMAP §9, KNOWN_ISSUES (KI-037 closed; new KIs), DEVELOPMENT_PROGRESS, CHANGELOG.
8. 7G is not required for Phase 7 completion.

---

**Follow-ups for other agents:**
- **database-engineer:** table-level design of migrations E–I, including the deferrable stop-sequence unique, the `ADD VALUE` placement and the partial-unique predicates in canonical form.
- **ui-ux-designer:** library desk, allocation flow with seat counts, route manifest print view, stock card, certificate preview / clearance panel, inbox bell, `/verify` page.
- **security-auditor:** the §11 gates.
- **qa-engineer:** concurrency harnesses for stock, seats, loans and serials.
- **devops-ci-engineer:** cron schedule note (still daily).

**Files cited:**
- `prisma\schema.prisma`: StoredFile 414-452, GeneratedDocument 454-497, Notification 521-547, Student 754-794, StudentGuardian 816-834, StudentEnrollment 870-905, StudentStatusChange 946-961, Employee 1048-1116, AcademicEvent 2049-2066, FeeChargeSource 2113-2116, StudentFeeCharge 2320-2348, FeeInvoice 2353-2399, FeeInvoiceItem 2401-2435, FeePayment 2440-2482
- `src\lib\rbac\catalog.ts` (42-44, 78-80, 97-104, 140-154, 203-222, 228-252, 258-262, 302-317, 333-337, 352-362)
- `src\lib\sequence.ts`
- `src\lib\import\tabular.ts` (17-25)
- `src\lib\rate-limit.ts` (16-57, 139)
- `src\modules\fees\fees.tx.ts`, `fees.policy.ts`, `concessions.service.ts` (38, 85-90, 346-431), `invoices.service.ts` (60-109, 126-234), `invoice-build.ts` (9-75), `ledger-reads.tx.ts`, `opening-balances.service.ts` (75)
- `src\modules\documents\documents.service.ts` (59-166), `src\modules\documents\templates\*`
- `src\modules\notifications\notifications.service.ts` (21-101)
- `src\modules\students\students.policy.ts`, `students.service.ts` (343-392, 415-419), `registration.ts` (5-11)
- `src\modules\hr\employees.service.ts` (392-398)
- `src\modules\academic\calendar.service.ts` (34, 70-103)
- `src\modules\settings\settings.service.ts` (414-436), `settings.rules.ts` (96-97)
- `src\app\api\cron\cleanup\route.ts`, `src\app\api\v1\**\export\route.ts`
- `docs\SYSTEM_ARCHITECTURE.md` (§2, §3), `docs\DATABASE_SCHEMA.md` (§9, §11, §14), `docs\KNOWN_ISSUES.md`, `docs\FREE_TIER.md` (51-57), `docs\PHASE_5_PLAN.md`, `docs\PHASE_6_PLAN.md`, `docs\PHASE_2B_CLOSURE_REPORT.md` (66), `docs\PHASE_3_PLAN.md` (46)
- `.claude\skills\import-export\SKILL.md`, `.claude\skills\fee-management\SKILL.md` (17), `.claude\skills\school-erp-architecture\SKILL.md`

**Points I did not check:**
- The grant baseline of 320 comes from docs; I counted only the 89 permissions. Run `npm run rbac:matrix` before the catalog change.
- How `calendar.portal.ts` and `notifications.portal.ts` filter internally. The plan avoids changing them, but the separation unit test should be written against the real code.
- Whether `registration.ts` can be reused for import without an `AdmissionApplication` row. Its header says it is called only by approval. Student import may need either a synthetic APPROVED application per row or a registration variant (design at 7F-M1, ADR-035 implications).
- The upload-rules purpose table and whether `GET /api/v1/files/:id` can take new purposes without a schema change (it should, since purpose is varchar(40)).
- Whether `pg_trgm` is available on Neon Free for catalogue search. The plan assumes prefix / ILIKE with `take`.
- The receipt and allocation immutability trigger SQL. Phase 7 never writes those tables, but the 7A-M4 / 7B-M4 snapshot tests should confirm it.