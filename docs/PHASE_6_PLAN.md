# Phase 6 — Parent and Student Portals: assessment and implementation plan

**Status: decisions P1–P24 APPROVED as recommended (owner, 2026-11-22)** — including P19 = UPI payment intimation (gateway stays deferred, `PAYMENT_GATEWAY=none`), P14 = optional student accounts from Class 9 (off by default), P15 = KI-105 fixed by migration A. Migration A applied to development and Test and catalog 89 / 13 / 320 synced (2026-11-22, 6A-M1). The §10 questions for the school are still open. Drafted by the architect agent from the code; file:line references were checked by the architect, not re-verified by the main session. Owner decisions P1–P24 are pending. Nothing is built yet. Like Phases 3–5, Phase 6 is split into three parts:
- **6A**: accounts, the family link and the portal shell;
- **6B**: what families see (read-only views);
- **6C**: communication, payment intimation and student accounts.

**Open items carried in.** They don't block planning, but they block "complete":
- **KI-059:** the integration and e2e runners still can't read `TEST_TARGET_*`. Phases 2B–5 are unverified on Test, and the portal reads all of their data. IDOR suites that never run prove nothing, so 6A-M4 can't close while KI-059 is open.
- **KI-106:** the runtime role owns the tables. Portal traffic makes this a public-facing surface, so it stays a go-live blocker (Phase 10).
- **KI-105:** a waived late fee is kept as a zero LATE_FEE line whose **description text holds the waived amount and the reason**. `getStudentFeeLedger` returns `items.description` verbatim (`src/modules/fees/invoices.service.ts:333`). The portal ledger must not show that text. This plan fixes KI-105 in the 6A migration, before any family-facing fee view ships (P15).
- KI-057 (3): no screen links or unlinks a guardian on an existing student. Phase 6 needs one.

---

## 1. Starting point (checked in the code)

### 1.1 What exists
- **The link columns exist, but they are not foreign keys.**
  - `User.studentId String? @unique` and `User.guardianId String? @unique` are plain columns. The schema comment says they "become FKs in Phase 6" (`prisma/schema.prisma:43-47`). `employeeId` is the precedent: it became a foreign key in 3A (ADR-036).
  - Because both columns are unique, the model already allows **one account per Guardian** and **one account per Student**.
- **Guardian model.**
  - `Guardian` (`schema.prisma:737-753`) holds name, a 10-digit `phone`, `altPhone`, `email` and `occupation`.
  - `phone` is indexed but **not unique** (`:751`). The mother and father are separate rows.
  - `StudentGuardian` (`:755-771`) holds relation, isPrimary and isEmergencyContact, with PK (student, guardian). It has **no flag to block portal access**.
  - Siblings share a Guardian **only if the admission reviewer linked one explicitly** (`AdmissionGuardian.linkGuardianId`, `:675-676`; "never auto-matched", `:661-662`). Duplicate Guardian rows for one real parent are therefore likely in practice.
- **Roles already in the catalog** (`src/lib/rbac/catalog.ts:308-325`):
  - **PARENT:** `student.read`, `attendance.student.read`, `fee.read`, `fee.pay.online`, `result.read`, `timetable.read`, all at CHILDREN, plus `notice.read`.
  - **STUDENT:** the same reads at SELF, plus `library.read` SELF, `fee.read` SELF and `notice.read`.
  - **No homework read permission exists.** Only `homework.manage` exists (`:93`).
  - Current counts are **86 / 13 / 312** (KI-101). Confirm with `npm run rbac:matrix` before the change.
- **`ALLOWED_SCOPES`** is derived from the default grants (`catalog.ts:339-349`). CHILDREN and SELF are therefore already offerable for those keys, and every service must refuse them until it implements them.
- **Every service refuses portal scopes today. This is fail-closed, which is correct.**
  - `students.policy.ts:12-20` throws Forbidden on CHILDREN / SELF.
  - `fees.policy.ts:7-12` only accepts `fee.read` at ALL (FC17).
  - `results.service.ts:25-27,48-61` gives "Parent / Student scopes see nothing" (AC20), and `renderReportCardPdf` requires `reportcard.generate` (`:398`).
  - `homework.service.ts:23`, `timetable.service.ts:14` and `calendar.service.ts:14,27` say "with the portal (AC20)".
  - `student-attendance.service.ts:47-54` only accepts ALL / ASSIGNED.
  - `admissions.policy.ts:7-8` refuses as well.
- **Sessions.**
  - `STAFF_SESSION_MS` is 8 h. `LONG_SESSION_MS` and `ABSOLUTE_SESSION_MS` are both 30 days (`src/lib/auth/session.ts:15-19`).
  - A long session is granted when "remember" is ticked **and the user holds any role keyed PARENT or STUDENT** (`src/modules/identity/auth.service.ts:28,80`).
  - `validateSessionToken` loads user → roles → permissions and builds `AuthContext` with `employeeId` (`session.ts:53-107`). It loads no guardian or student link.
- **AuthContext** (`src/lib/rbac/authorize.ts:7-24`) has `employeeId` but no `guardianId`, `studentId` or children.
  - `scopeFor` returns the **widest** scope (`:51-56`, rank ALL > ASSIGNED > CHILDREN > SELF).
  - So a Teacher who is also a Parent has `student.read` = ASSIGNED and never reaches CHILDREN.
- **Account creation.**
  - `createUser` needs `user.manage`, issues a one-time temporary password and sets `mustChangePassword` (`src/modules/identity/users.service.ts:132-159`). `adminResetPassword` is at `:229-246`. Temporary passwords come from `src/lib/auth/temp-password.ts:7` (~70 bits).
  - Anti-escalation (`identity.policy.ts:40-98`) means only a holder of **every** permission a role grants can assign it.
  - School Admin has **no `user.manage`** and lacks `result.read` and `fee.pay.online` (`catalog.ts:198-215`). **Today only a Super Admin can create Parent accounts.**
- **Password reset.**
  - The self-service reset puts the token in the URL fragment (`password-reset.service.ts:20-26`).
  - It silently does nothing for accounts without an email (`:53`). Most Indian parents will have none on file.
- **Login and shell.**
  - Login always redirects to `/erp` or `/erp/change-password` (`src/app/(auth)/login/actions.ts:31`). `requireAuth` redirects pending changes to `/erp/change-password` (`src/lib/auth/context.ts:28`).
  - The ERP layout renders for **any** signed-in user (`src/app/erp/layout.tsx:14-17`), so a Parent today sees the ERP shell with Dashboard and My account.
  - The nav hides Students and Fees for CHILDREN / SELF through the `scope` filters (`src/components/erp/nav-items.ts:43-48,90-97`).
- **Notifications and notices.**
  - The `Notification` model exists: userId, type, title, body, link, channel IN_APP / EMAIL / SMS and readAt (`schema.prisma:496-517`). No service reads or writes it; the only `notification.*` reference in `src/` is the catalog.
  - **No `Notice` model exists.** `notice.read` is granted to every role but has no screen.
  - The module map puts `Notice` in `cms`, which is Phase 8 (`docs/SYSTEM_ARCHITECTURE.md:80`).
- **Fees.**
  - `FeePayment` (`schema.prisma:2365-2402`) has `receiptNo` NOT NULL UNIQUE and status only SUCCESS / CANCELLED (`:2083-2086`). Immutability triggers sit on receipts and allocations (Phase 5 §10 M1).
  - `PaymentGatewayEvent` doesn't exist; ADR-042 records the gateway design.
  - Receipt PDF copies are ORIGINAL / DUPLICATE for `fee.collect` holders and "OFFICE COPY — NOT FOR ISSUE" for other readers (Phase 5 §16 L2).
- **Data minimisation helps.** Student holds no Aadhaar or medical data (`schema.prisma:694-696`, design D6), so the portal has no Aadhaar or medical field to leak today.
- **Rate limits** live in `src/lib/rate-limit.ts:15-42`: login per IP, per user+IP and failures per user; reset; `receiptPdf` 60 / 10 min. There is no rule for activation or portal PDFs.

### 1.2 What is missing (summary)
1. A real User↔Guardian / User↔Student link: foreign keys, a link service and audit.
2. A way to provision hundreds of family accounts without SMS and within 90 emails a day, by someone other than the Super Admin.
3. Children resolved per request, and a CHILDREN / SELF branch in every read service the portal uses.
4. A separate portal shell, and keeping portal accounts out of `/erp`.
5. Notices (model, compose, audience), an in-app notification service, and a parent-facing payment path that is free.
6. A per-child access block (custody cases), leaver rules and consent capture (DPDP Act).

---

## 2. Proposed design (summary)

### 2.1 Module ownership

| Concern | Owner | Notes |
|---|---|---|
| Portal user creation, activation codes, consent stamp, link columns on `User` | `identity`: new `portal-accounts.tx.ts` + `activation.service.ts` | Identity owns User. It refuses any role set other than exactly `{PARENT}` or `{STUDENT}`. Called by students under the guardian / student lock (the HR `linkStaffAccount` pattern, `src/modules/hr/staff-accounts.service.ts:40-51`) |
| Provisioning UI flows (per student, per section in bulk), guardian↔student links, the `portalAccess` block, guardian merge-or-link | `students`: new `family-accounts.service.ts` + `guardian-links.service.ts` | Students owns Guardian / StudentGuardian. Lock order: student → guardian(s) ORDER BY id → user |
| CHILDREN / SELF record check | **`lib/rbac/portal-scope.ts` (pure)**, fed by `AuthContext.portal` | See §2.2 and ADR-044 |
| Family-facing reads | Each domain module adds `*.portal.ts` read functions: `students/students.portal.ts`, `students/student-attendance.portal.ts`, `academic/results.portal.ts`, `academic/homework.portal.ts`, `academic/timetable.portal.ts`, `academic/calendar.portal.ts`, `fees/fees.portal.ts` | Every function: `authorize(ctx, key)` → `assertPortalStudent(ctx, key, studentId)` → explicit `select` from a portal whitelist. No family read goes through staff functions |
| Notices (internal, not CMS) | new `notices` module (`Notice`, `NoticeTarget`, `NoticeRead`) | Separate from Phase 8 CMS notices (public website). ADR-047. Depends on academic (classes / sections) and students (audience resolution) |
| In-app notifications | new `notifications` module (`notifications.service.ts`: `enqueueAfterCommit`, list, mark read) | Owns `Notification`. Domain services call it **after commit** (backend rule). Depends on nothing domain-side: callers pass user ids, resolved by students `guardianUserIdsOf(studentIds)` |
| Payment intimation (UPI claim) and the optional gateway | `fees`: `payment-claims.service.ts`; `lib/payments/` interface + `none` driver | The claim is confirmed through the existing collection path (same locks, sequence, receipt) |
| Portal composition (home cards, child switcher data) | **No new domain module.** Pages under `src/app/portal/**` call the `*.portal.ts` functions | Avoids a "portal" module that would need every module's tables |

**Dependency direction** (check with `npm run check:deps`):
- students → identity (already the HR pattern);
- fees, academic, notices → students for audience and guardian reads, through exported `*.tx.ts` helpers;
- anything → notifications;
- `lib/rbac/portal-scope` → nothing.

**Watch the existing edge:** `identity/users.service.ts:10-11` already imports `modules/academic`. The new `identity/portal-accounts.tx.ts` must not import students, or a cycle appears. Students calls identity, never the reverse.

### 2.2 How every service resolves "my children" (ADR-044)
- `validateSessionToken` adds `guardianId` and `studentId` to its existing single query, plus `guardian.students` where `portalAccess = true AND student.deletedAt IS NULL`, selecting studentId, status and leftOn.
  - This produces `ctx.portal = { kind: "PARENT" | "STUDENT" | null, guardianId, studentId, children: [{ id, status, accessUntil }] }`.
  - There is **one query per request and no extra round trip**. Revocation (an unlinked or blocked child, a deactivated user) works on the next request, because nothing is cached across requests.
- `lib/rbac/portal-scope.ts` (pure, unit tested):
  - `portalScopesFor(ctx, key)` checks **set membership**, not the widest scope. CHILDREN applies only if the user's scopes for `key` contain CHILDREN, and SELF likewise.
  - `assertPortalStudent(ctx, key, studentId, { allowLeaver })` passes for CHILDREN when the id is in `ctx.portal.children` and inside the leaver window, and for SELF when the id equals `ctx.portal.studentId`. Otherwise it throws **NotFoundError**, identical for "missing" and "not yours" (no existence oracle; KI-058 rule).
- Each module's `*.policy.ts` gains an explicit CHILDREN / SELF branch that calls this helper. For example, `studentScopeWhere` adds `{ id: { in: ctx.portal.children… } }`. Staff-facing functions keep refusing portal scopes: portal reads are separate functions, so a staff list can never be widened by accident.
- Records that hang off a student (receipt, report card, homework attachment) are loaded first by id with `studentId` (or `enrollment.studentId` / `section`) selected. The helper is then applied to **that** student id, and NotFound is returned before any field leaves the service.
- **Rejected alternatives:**
  - A resolver inside `students`, imported by fees and academic: this risks file-level cycles (academic ↔ students) and adds a query per service.
  - A `portal` module reading other modules' tables: this violates `.claude/rules/architecture.md`.
  - Caching the children map across requests: revocation would lag in custody cases.

### 2.3 Account kinds and the shell (ADR-045)
- **Portal accounts are exclusive.**
  - A user with PARENT or STUDENT holds **no other role**, and never both.
  - This is enforced in identity (`assertCanAssignRoles` plus the portal service), with a static test that refuses mixed role sets in the seed and in updates.
  - A staff member who is also a parent gets a **second, separate parent account**. This is common in Indian schools: teachers' children study there.
  - It removes two existing hazards: a staff account getting a 30-day session (`auth.service.ts:80`), and `scopeFor` hiding CHILDREN behind ASSIGNED.
- **The portal shell is `/portal`**, with its own layout, bottom navigation and child switcher, in `src/components/portal/`.
  - `src/app/portal/layout.tsx` calls `requirePortal()`. Staff users go to `/erp`.
  - `src/app/erp/layout.tsx` redirects portal accounts to `/portal`.
  - Login redirects by account kind.
  - `requireAuth` sends a pending password change to `/portal/change-password` for portal accounts.
  - No ERP navigation is imported into the portal (a static guard test checks this).
- **URLs carry the child:** `/portal/c/[studentId]/attendance|results|homework|timetable|fees|profile`. Every page re-checks access through the service; the URL is untrusted input (this is the IDOR target).
- **Pages stay dynamic** (ADR-024). Cache data, not pages (§2.5).

### 2.4 Provisioning without SMS (ADR-046)
- **Activation codes.**
  - The school office generates an account per guardian (and later per student). Each gets a **one-time activation code**, printed on an activation slip (PDF, like ID-card bulk PDFs). Slips are batched per section and handed out at PTM or admission, or put in the diary in a sealed envelope.
  - Optional: when the guardian has an email, the office sends an invitation link `/activate#code=…`. The code goes in the fragment; the page strips it and POSTs it (security rule). Each email goes through `lib/usage.consume("email.sent")`, capped at 90 a day, so the office sees "N invitations queued for tomorrow" rather than silent failure.
  - **The code:** 10 characters from the no-look-alike alphabet (`temp-password.ts:4`, ~57 bits). Stored as SHA-256 only. Valid 21 days. Single use. Only the newest code works, as with reset tokens.
- **Activation page** `/activate`:
  - The parent enters the username (printed), the code, and the **child's date of birth** as a second knowledge check. The DOB check reduces the damage if a slip is lost and costs nothing.
  - Next comes the **privacy notice and consent** (DPDP Act, verifiable parental consent; version stored), then the new password (existing policy).
  - The account becomes usable. The temporary-password path stays as the admin fallback ("Reset password" issues a new slip, not a reset email).
- **Username = the guardian's 10-digit mobile number** when it is unique among active users. Otherwise the office chooses one, or the guardians are linked or merged first. Students use their Student ID in lower case (`demo-2026-0001`).
- **Who provisions:** the new `portal.account.manage` permission (School Admin; Super Admin automatically). Its service creates only users whose role set is exactly `{PARENT}` / `{STUDENT}`, and touches only portal-only accounts.
  - It also **refuses** if the PARENT or STUDENT role has been edited to hold anything outside a fixed allowlist: the portal read permissions at CHILDREN / SELF, `notice.read`, and the payment / claim permission.
  - So a role edit can never turn bulk provisioning into privilege escalation. This sits beside, not instead of, `assertCanModifyUser` for every other account.

### 2.5 Caching and the Neon budget
- **Session lookup.** It stays one query per request (extended include). Optional, as P20: an in-process cache of `AuthContext` keyed by token hash, 30 s TTL, evicted locally on sign-out or revoke. This only works on one process (the standalone server), and revocation by an admin lags up to 30 s. **Recommended only if measurement shows a need.**
- **Data.** Per-student read models (attendance month, published report-card list, fee ledger summary) go through a data cache keyed by `(model, studentId, sessionId)` with **tag invalidation on the writing service**:
  - marking attendance invalidates `attendance:{sectionId}:{month}`;
  - publishing invalidates `results:{examId}`;
  - collection or cancellation invalidates `fees:{studentId}`.
  - Authorization (`assertPortalStudent`) always runs **before** the cache read, and keys never mix students. A security review covers this.
  - School-wide data (calendar month, timetable of a section, notices of an audience) is cached per section or audience.
- **Rate limits** (new `RULES`):

| Rule | Limit |
|---|---|
| `activationPerIp` | 10 / h |
| `activationPerUser` | 5 / h, plus lock after 5 wrong DOB / code |
| `portalPdf` | 30 / 10 min / user |
| `paymentClaim` | 5 / day / user |
| `noticeCompose` | 30 / h / user |

  - Existing login limits apply unchanged.
  - Portal pages themselves aren't rate limited, but every read is bounded (`take`) and cached.

### 2.6 Lock orders (new or touched)
- **Provisioning:** student FOR UPDATE (students' existing order, `students.service.ts:36-38`) → guardian rows FOR UPDATE ORDER BY id → user insert or update (identity) → activation insert. Bulk runs as one transaction per section, ≤ 60 students, 30 s cap.
- **Guardian link, unlink or block:** student → guardian → (user untouched; access ends because the request-time resolver reads `portalAccess`).
- **Activation:** user row FOR UPDATE → activation row FOR UPDATE (re-check unused, unexpired and newest) → update. Argon2 hashing runs **outside** the transaction, then the state is re-checked under lock (backend rule).
- **Payment-claim confirmation:** reuses collection's order. Per-student advisory lock (`lockFeeStudent`) → claim row FOR UPDATE → invoice rows ORDER BY id → sequence (last). A parent's claim submit takes no student lock (insert only; partial unique on the reference).
- **Gateway, if ever enabled (ADR-042):** student lock → payment row FOR UPDATE → event insert U(gateway, eventId) → invoices → sequence. Whichever of verify or webhook arrives first wins.

---

## 3. Owner decisions needed (P1–P24)

| # | Decision | Recommendation |
|---|---|---|
| **P1** | Split Phase 6? | **Yes: 6A / 6B / 6C**, each with its own review, verification and closure (§6) |
| **P2** | Account model | **One account per Guardian** (`User.guardianId` unique, already in the schema). Siblings appear under that one login through `StudentGuardian`. Mother and father may each have their own account; they never share a password. At launch the office provisions the **primary guardian** of each student; others on request |
| **P3** | Staff who are also parents | **A separate parent account** (different username). Portal roles are exclusive (ADR-045): never combined with staff roles, and PARENT never with STUDENT |
| **P4** | Provisioning | **Office-issued activation codes on printed slips** (bulk per section, plus per student), activation with code + child's DOB + consent + own password. **Optional email invitation** with the code in the URL fragment, within the 90/day cap. **No self-registration.** It would need identity proof the school can't do online (no SMS OTP) and would let anyone who knows a phone number try to claim a child |
| **P5** | Login identifier | **The guardian's 10-digit mobile number as username** where unique among active users; otherwise an office-chosen username. Students: their Student ID. No OTP / SMS (free-only). Same `/login` page, which redirects by account kind |
| **P6** | Forgotten password (no email on file) | **Office reset** → a new activation slip (code, not a temporary password, so it expires). Self-service email reset when the account has an email (existing flow). The office reset needs `portal.account.manage` and is audited |
| **P7** | Long sessions | **Keep the current rule:** "Keep me signed in" (unticked by default) → 30 days idle, **30 days absolute** (`session.ts:15-19`), only for portal-only accounts (P3 closes the staff loophole at `auth.service.ts:80`). A visible "Sign out" in the portal header, and "Sign out other devices" on the portal account page (shared family phones) |
| **P8** | Separate portal shell | **Yes: `/portal`** with its own layout, bottom nav (Home, Attendance, Results, Fees, Notices) and child switcher. Portal accounts can never render `/erp` (redirect). No ERP navigation code reused |
| **P9** | What families see — student information | Name, Student ID, admission no., class / section / roll no. for the current session, DOB, gender, photo, own guardian contacts, address. **Read-only.** Corrections go through the school office (no edit forms in Phase 6). **Not shown:** other guardians' contacts when the viewer is blocked from them, documents (birth certificate, TC), status-change reasons, duplicate-match data, internal remarks |
| **P10** | Attendance | Month calendar + session percentage of the child's current enrollment, holidays and weekly off marked. Past sessions: the percentage only, shown on report cards |
| **P11** | Results | **Only PUBLISHED report cards** (ReportCard rows exist only after publication, `schema.prisma:1887-1909`), all sessions of the child. PDF as a **"PARENT COPY"** rendered from the snapshot (new portal path; `renderReportCardPdf` stays staff-only). Rank only as the snapshot has it (school setting `showRank`). Marks before publication: **never** |
| **P12** | Homework, timetable, calendar | **Yes, all three** for the child's current section: homework (with attachment download, `homework.read` new), section timetable (subject + teacher display name), academic calendar (events, holidays, exam dates) |
| **P13** | Fees | **Yes:** dues by installment (live late fee as of today, as the counter shows it), invoices and items, receipts list + **receipt PDF "PARENT COPY"** (uncounted; ORIGINAL / DUPLICATE stays a counter matter). **Never shown:** concession reasons, cancel reasons, waiver reasons (KI-105, see P15), references other than the parent's own claim, collector notes. A cancelled receipt shows "Cancelled" without the reason |
| **P14** | Student accounts | **Optional, off by default.** School setting `portal.studentAccounts` with a minimum class level, **recommend Class 9** (the school chooses). A parent must have activated first (DPDP: consent by the parent); the student account is created by the office, with the activation slip given to the parent. Students see P9–P12 for themselves; **not fees** (P16) |
| **P15** | KI-105 before the portal ledger | **Fix in the 6A migration:** waiver columns on `fee_invoice_item` (`waivedAmount`, `waiverReason`, `waivedById`, `waivedWithPaymentId`) and `frozenByPaymentId` on LATE_FEE lines. Backfill existing waiver lines (reviewed SQL). The portal renders fixed labels ("Late fee", "Late fee waived") and never `description` for LATE_FEE lines. If the owner prefers not to migrate fees now: the portal ledger uses a whitelist mapping and never shows `description` for LATE_FEE kinds (a code-only fallback) |
| **P16** | Catalog changes | See §4. **+3 permissions** (`homework.read`, `notice.manage`, `portal.account.manage`) and a **payment-claim permission only if P19 is approved**. **Remove `fee.read` SELF from Student** (parents in Indian schools generally don't want children seeing dues). Keep `library.read` SELF for Phase 7 |
| **P17** | Leavers and alumni | A guardian of a student who has left (TRANSFERRED / WITHDRAWN / GRADUATED, or enrollment LEFT) keeps **read-only access to that child's report cards and receipts for 180 days** from the leaving date (school setting `portal.leaverAccessDays`; 0 = none). No attendance / homework / timetable after leaving. When **no** linked child is within access, the account is deactivated by the daily cleanup cron (audited, reversible by the office). Student accounts are deactivated at leaving, in the same transaction as the status change |
| **P18** | A guardian linked to several students across sessions | The link is session-independent (`StudentGuardian`). Each child shows its **own current enrollment**. Past sessions appear only in results and fees history. Siblings split across duplicate Guardian rows are fixed with **"Link an existing guardian to this student"** plus a **guardian merge** (office, `student.update` + `portal.account.manage`, audited; refused when both guardians already have accounts — the office deactivates one first). This closes KI-057 (3) |
| **P19** | Paying fees from the portal | **The free path: UPI payment intimation.** The portal shows the school's UPI ID / QR (settings) and the amount due. The parent pays in their own UPI app, then submits the UTR. The Accountant matches it against the bank statement and **confirms**, which records a normal UPI collection through the existing service (receipt number, allocation, PDF) — or **rejects** it with a reason. No money passes through the app, no merchant account, no fee per transaction. **The online gateway (ADR-042):** land the `lib/payments` interface + `none` driver + a test-only fake driver with the full PENDING / verify / webhook / `PaymentGatewayEvent` pipeline tested, **but only if the owner opts in to a gateway**. Otherwise defer again: no schema change to `fee_payment`, no routes, no button. `PAYMENT_GATEWAY=none` stays the default in every case. Recommendation: **UPI intimation in 6C; gateway stays deferred** (Razorpay needs KYC and charges per transaction; FREE_TIER policy) |
| **P20** | Neon compute: authentication cache | **Measure first** on Test with a synthetic evening load (§7). An in-process 30 s AuthContext cache only if measured awake hours exceed budget. Its revocation lag needs owner acceptance |
| **P21** | Messaging scope | **Notices (one-way, school → families) + in-app notifications. No two-way chat** in Phase 6 (safeguarding, moderation, staff workload, data retention). A notice may name a contact ("call the office on …") |
| **P22** | Notice authorship and audience | `notice.manage`: School Admin and Principal (whole school / class / section; families, staff or both); **Class Teacher at ASSIGNED** (own section, families only). Plain text (≤ 4,000 characters) + one optional PDF / image attachment (private storage, existing upload rules). Publish now or scheduled, optional expiry, withdraw (never edit after publish; withdraw and republish). Read receipts ("seen by 64 % of families") |
| **P23** | Which events notify families (in-app only) | Result published (per child), **absence marked** (same day, once per child per day), receipt issued / cancelled, payment claim confirmed / rejected, notice published to the child's audience. **Email for events: off** (90/day cap). Email is used only for invitations and resets. No SMS, no WhatsApp. FC22 (reminders): an **in-app "dues overdue" banner computed live** on portal home. No reminder emails or jobs |
| **P24** | Custody / restricted guardians | `StudentGuardian.portalAccess` (default true). The office can block one guardian from one child without deleting anything (audited, takes effect on the next request). Blocked guardians are never told why ("No children are linked to this account") |

---

## 4. RBAC (proposed)

| Capability | Super Admin | School Admin | Principal | Vice Principal | Class Teacher | Accountant | Parent | Student |
|---|---|---|---|---|---|---|---|---|
| Provision, reset, block, deactivate portal accounts (**new `portal.account.manage`**) | ✓ | **✓ (new)** | — | — | — | — | — | — |
| Link / merge guardians (`student.update` ALL + `portal.account.manage`) | ✓ | ✓ | — | — | — | — | — | — |
| Compose / publish notices (**new `notice.manage`**) | ✓ | **✓** | **✓** | — (P22: owner may add) | **A (own section)** | — | — | — |
| Read notices (`notice.read`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | audience of own children | audience of own section |
| Student info / attendance / results / timetable (existing keys) | ALL | … | … | … | … | … | **C** | **S** |
| Homework read (**new `homework.read`**) | ✓ | — (has `homework.manage`) | — | — | — (manage) | — | **C (new)** | **S (new)** |
| Fees ledger / receipts (`fee.read`) | ALL | ALL | ALL | ALL | — | ALL | **C** | **removed (P16)** |
| UPI payment intimation (reuse `fee.pay.online` CHILDREN, P19) | — | — | — | — | — | confirm with `fee.collect` | **C** | — |

- **Catalog change:**
  - **+3 permissions:** `homework.read`, `notice.manage`, `portal.account.manage`.
  - **Grants:** +3 Super Admin (automatic); `homework.read` Parent C + Student S (+2); `notice.manage` School Admin + Principal + Class Teacher A (+3); `portal.account.manage` School Admin (+1); Student `fee.read` SELF removed (−1).
  - **Totals:** **86 / 13 / 312 → 89 / 13 / 320.** Confirm the baseline with `npm run rbac:matrix` first.
  - `fee.pay.online` is reused for the claim, so it needs no new permission. If the owner wants a distinct key (`fee.claim.submit`), add +1 / +2.
  - Synced to development and Test with approval, using the KI-062 / KI-073 procedure.
- **`ALLOWED_SCOPES`:** `notice.manage` gains ASSIGNED, and `homework.read` gains CHILDREN / SELF only (no ALL in default roles, but ALL is always offered — **the homework portal reads must also handle ALL** or be documented as portal-only).
- **Anti-escalation note:** School Admin will be able to manage portal-only accounts **only through `portal.account.manage`**, never through generic `/erp/users`. `/erp/users` stays `user.manage`; School Admin still doesn't hold it.
- **Invariants (tests):**
  - Parent and Student hold no write permission except `fee.pay.online` (the claim).
  - No portal role holds an ALL or ASSIGNED grant.
  - Portal roles are exclusive.
  - Every key granted at CHILDREN / SELF has a portal read function with an IDOR test.

---

## 5. Schema changes (migration outline, expand-only)

**Migration A** — `2026112x000000_phase6a_portal_accounts`. Needs owner approval of the SQL, then development, then Test.
1. **`user.guardian_id` → FK** `guardian(id)` ON DELETE RESTRICT, and **`user.student_id` → FK** `student(id)` ON DELETE RESTRICT.
   - Pre-check in the SQL: fail if any non-null value is orphaned. Expected: none set.
   - The unique indexes already exist.
   - Plus a **CHECK** that `guardian_id` and `student_id` are not both set; also neither with `employee_id`. Portal accounts are not staff accounts (ADR-045).
2. **`user.privacy_consent_at timestamptz NULL`, `user.privacy_consent_version varchar(20) NULL`**: DPDP proof of consent at activation.
3. **`student_guardian.portal_access boolean NOT NULL DEFAULT true`** (P24).
4. **New `account_activation`:**
   - Columns: id, user_id → user CASCADE, code_hash unique, expires_at, used_at, created_by_id → user SET NULL, channel (SLIP / EMAIL), failed_attempts smallint default 0, created_at, updated_at.
   - Indexes: (user_id); (expires_at) for cleanup.
   - The "only the newest code works" rule is enforced in the service under the user lock.
5. **KI-105 (P15):**
   - `fee_invoice_item.waived_amount numeric(12,2) NULL`, `waiver_reason varchar(500) NULL`, `waived_by_id` → user SET NULL, `waived_with_payment_id` → fee_payment RESTRICT, `frozen_by_payment_id` → fee_payment RESTRICT.
   - Backfill of existing waiver lines from their text (reviewed SQL, dry-run count first).
   - Check the immutability triggers on items still allow this one-off backfill; the DDL runs as the owner role (KI-106).
6. **`notification.dedupe_key varchar(120) NULL`** + partial unique (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL, plus index (user_id, created_at DESC). This gives idempotent fan-out on retries: one absence alert per child per day.

**Migration B** — `…_phase6c_notices` (6C-M1):
7. **`notice`:**
   - Columns: id, title varchar(150), body varchar(4000), audience (FAMILIES / STAFF / ALL), scope (SCHOOL / CLASS / SECTION), academic_session_id → session RESTRICT, status (DRAFT / SCHEDULED / PUBLISHED / WITHDRAWN), publish_at, expires_at NULL, attachment_file_id → stored_file unique NULL, created_by_id, published_by_id, withdrawn_by_id, withdrawn_at, version, created_at, updated_at, deleted_at (drafts only hard-deleted).
   - CHECKs: published ⇒ published_by + publish_at; expires_at > publish_at.
   - Index (status, publish_at).
8. **`notice_target`:** notice_id, class_id NULL, section_id NULL (composite FK to the section's session). CHECK exactly one per scope kind.
9. **`notice_read`:** (notice_id, user_id) PK, read_at.

**Migration C** — `…_phase6c_payment_claims` (6C-M3, only if P19 is approved):
10. **`fee_payment_claim`:**
    - Columns: id, student_id → student, amount numeric(12,2) CHECK > 0, method (UPI / BANK_TRANSFER), transaction_ref varchar(40) normalized, paid_on date, submitted_by_id → user, status (SUBMITTED / CONFIRMED / REJECTED), payment_id → fee_payment unique NULL, decided_by_id, decided_at, reject_reason varchar(300), version, created_at, updated_at.
    - **Partial unique** (transaction_ref) WHERE status IN ('SUBMITTED','CONFIRMED'), written in canonical form (KI-055 rule).
    - CHECKs: CONFIRMED ⇔ payment_id; REJECTED ⇒ reason; decided_by ≠ submitted_by.
    - Index (status, created_at).

**Migration D** — only if the owner opts in to a gateway (ADR-042). **Not planned by default:**
- `FeePaymentStatus` + PENDING / FAILED; `receipt_no` nullable until SUCCESS (CHECK SUCCESS / CANCELLED ⇒ receipt_no);
- `gateway`, `gateway_order_id` unique, `gateway_payment_id` unique;
- `payment_gateway_event` (id, gateway, event_id, type, payment_id, payload_sha256, received_at, U(gateway, event_id));
- the receipt immutability triggers updated to allow exactly PENDING → SUCCESS / FAILED once.
- Its own security review.

**No migration** for school settings: `SchoolSetting.features` JSON gains a Zod-validated `portal` block: `studentAccounts`, `studentMinClassLevel`, `leaverAccessDays`, `upi: { payeeName, vpa, qrFileId? }`, `privacyNoticeVersion`. This follows the `idFormats` precedent. The UPI QR image is a public-safe school asset in private storage, served to portal users only.

Docs in the same changes: DATABASE_SCHEMA, DATABASE_RELATIONSHIPS, guard tests per migration (the `migration-phase*.test.ts` pattern), and `db:check` table list. Table-level details go to **database-engineer**.

---

## 6. Milestones

| Milestone | Content | Tests / gate |
|---|---|---|
| **6-M0** | Owner decisions P1–P24 and the §10 questions. KI-059 resolved (IDOR suites must run). Phase 2B / 4B / 5 suites green on Test | Owner |
| **6A-M1** | Migration A (`--create-only`, offline diff, guard test). Catalog change (§4) + seed + RBAC_MATRIX. `lib/rbac/portal-scope.ts` (pure). Portal settings schema in `settings.schemas` | Unit: portal-scope truth table (CHILDREN / SELF / leaver window / mixed scopes / blocked), catalog invariants (exclusive roles, no portal ALL grants, allowlist). SQL approval → development → Test |
| **6A-M2** | AuthContext `portal` block in `validateSessionToken`. ADR-045 exclusivity in identity (create / update / seed). Long-session rule limited to portal-only accounts. Login / `requireAuth` redirects by kind. `/portal` layout, nav, child switcher, account page (change password, sign out other devices). **Student profile view** (`students.portal.ts`), so the shell ships with real content and no placeholders. ERP layout redirects portal accounts | Unit: redirect matrix, nav has no ERP hrefs (static guard), every `src/app/portal/**/page.tsx` calls `requirePortal`. Integration: context resolves children; unlink / block / soft-delete takes effect next request; mixed role set refused; staff gets 8 h even with "remember" |
| **6A-M3** | Provisioning: `identity/portal-accounts.tx.ts`, `activation.service.ts`; `students/family-accounts.service.ts` (per student, bulk per section); activation slip PDF (`documents/templates/activation-slip.tsx`; no DOB or phone printed, only name, username and code); `/activate` page + action (code + DOB + consent + password; fragment support for email); optional email invitation via `lib/email` + `usage.consume`; office reset → new slip; deactivate; `guardian-links.service.ts` (link existing guardian, merge, `portalAccess` block). ERP screens: "Family access" tab on the student profile, "Portal accounts" per section | Integration: bulk per section idempotent (re-run issues no second account; new codes only on request); code single-use under concurrency (two activations → one wins); expired / superseded code refused with the **same** message as a wrong code; DOB mismatch counts toward lock; consent stamped; username collision → conflict without revealing the other account; School Admin can't touch non-portal accounts via this path; role-allowlist refusal when PARENT is edited; merge refused when both have accounts; audit has no code, DOB or password. Rate-limit tests |
| **6A-M4** | Security review (security-auditor: auth, sessions, RBAC, activation). **IDOR suite v1** (student profile, photo) table-driven. e2e: activate → login → profile at 360 px, axe clean | Owner sign-off |
| **6B-M1** | `student-attendance.portal.ts` (month, session %), `timetable.portal.ts`, `calendar.portal.ts`. Data cache + tag invalidation from `markStudentDay` / timetable / calendar writers | Integration: only the child's section and enrollment window; a promoted child shows the new section; cache invalidated by marking; IDOR rows added |
| **6B-M2** | `results.portal.ts` (published report cards across sessions, PARENT COPY PDF via `GET /api/v1/portal/report-cards/[id]/pdf`, rate limit `portalPdf`); `homework.portal.ts` (current section, attachment via `GET /api/v1/portal/homework/[id]/attachment`) | Integration: unpublished exam invisible (list and by id); another child's card → 404; snapshot rendered (later scale edit no effect); attachment of another section → 404; PDF label "PARENT COPY", no counter |
| **6B-M3** | `fees.portal.ts`: ledger (P13 whitelist, KI-105 columns), live late fee as of today, receipts list + PDF `GET /api/v1/portal/receipts/[id]/pdf` (uncounted PARENT COPY); `fees.policy` gains an explicit portal branch; overdue banner on portal home (FC22 in-app) | Integration: no reason or description leak (asserted on serialized output), cancelled receipt without reason, the counter's ORIGINAL / DUPLICATE count unchanged by portal downloads, sibling ledgers separate, leaver within / after window |
| **6B-M4** | Verification on Test: **full IDOR suite**, e2e portal journeys at 360 / 768 / 1280 (axe), Neon load measurement (§7), browser review | Owner sign-off |
| **6C-M1** | Notices module + migration B: compose / schedule / publish / withdraw (ERP `/erp/notices`), audience resolution, attachment, read receipts; portal and staff notice lists (`notice.read`); cache per audience | Integration: section notice invisible to other sections' parents; class-teacher limited to own section (ASSIGNED, open session); scheduled not visible early; withdrawn disappears; expired hidden; staff-only notice invisible to families; read receipt counts |
| **6C-M2** | Notifications module: `enqueueAfterCommit`, inbox / bell in the portal (and ERP header later), mark read, dedupe; wiring from results publish, absence marking, receipt issue / cancel, claim decisions, notice publish; daily cleanup (90-day retention) in `/api/cron/cleanup` | Integration: one absence alert per child per day (re-mark doesn't duplicate); a rolled-back write sends nothing; blocked guardian gets nothing; fan-out of 1,000 cards bounded (`createMany` batches) |
| **6C-M3** | (P19) Payment intimation: settings UPI block; portal "Pay by UPI" page (amount due, VPA / QR, submit UTR); Accountant queue `/erp/fees/claims` (match, confirm → existing collection, reject with reason); migration C. Gateway: **only if opted in** — `lib/payments` + fake driver tests per ADR-042 | Integration: duplicate UTR refused (claims and existing payments); confirm creates exactly one receipt under concurrency (two accountants); confirm ≠ submitter; reject frees the UTR; over-claim beyond dues refused at confirm; parent sees status only. Security review (payments) |
| **6C-M4** | (P14) Student accounts behind the setting: provisioning after parent activation, SELF reads reuse the `*.portal.ts` functions, no fees, deactivation on leaving | Integration: SELF only; a sibling's id → 404; setting off → provisioning refused; leaving deactivates in the same transaction |
| **6C-M5** | Verification on Test, security review of 6C, e2e at 360, closure report, docs | Owner sign-off |

**Planned file layout:**
- `src/lib/rbac/portal-scope.ts`
- `src/modules/identity/{portal-accounts.tx,activation.service,activation.schemas}.ts`
- `src/modules/students/{family-accounts.service,guardian-links.service,students.portal,student-attendance.portal,guardian-users.tx}.ts`
- `src/modules/academic/{results,homework,timetable,calendar}.portal.ts`
- `src/modules/fees/{fees.portal,payment-claims.service,payment-claims.schemas}.ts`
- `src/modules/notices/*`, `src/modules/notifications/*`
- `src/app/portal/**`, `src/app/(auth)/activate/*`, `src/app/api/v1/portal/**`
- `src/components/portal/*`
- `src/modules/documents/templates/activation-slip.tsx`

Visual specs (portal home cards, child switcher, attendance calendar, ledger cards, the UPI page) come from **ui-ux-designer**.

---

## 7. Tests (required)

- **IDOR suite** (`tests/integration/portal-idor.test.ts`), table-driven.
  - **Actors:** Parent A (children A1, A2), Parent B (child B1), Parent A2nd (other guardian of A1, blocked), Student A1, Student B1, leaver-parent (child left 200 days ago), Teacher, Accountant, unauthenticated.
  - **Resources:** student profile, photo, attendance month, report-card list / PDF, homework list / attachment, timetable, fee ledger, receipt PDF, notice by id, payment claim, notification mark-read.
  - **Ids:** own child, sibling, other family's child, deleted student, nonexistent cuid, a well-formed id of another *type*.
  - **Expected:** allowed or **identical 404**, the same body and status for "missing" and "not yours". Asserted for server actions, pages (HTTP status) and API routes.
  - **Also covered:** id swapping in form fields (studentId in a claim, noticeId in mark-read), and a stale child after unlink in the middle of a session.
- **RBAC matrix:** regenerated, plus `tests/integration/portal-rbac.test.ts`.
  - Every new endpoint and action: forbidden roles get 403 or the not-permitted screen.
  - Portal accounts get a redirect from every `/erp/**` route; staff get a redirect from `/portal/**`.
- **Unit:**
  - portal-scope;
  - activation code format, hashing and expiry;
  - redirect-by-kind;
  - exclusivity rules;
  - notice audience resolution;
  - leaver window (school time zone);
  - ledger whitelist mapping (no `description` for LATE_FEE kinds);
  - static guards (no ERP nav import in portal, `requirePortal` in every portal page, every `*.portal.ts` export calls `assertPortalStudent` — a source scan test).
- **E2E (Playwright, 360 × 800 phone, plus 768 / 1280, axe clean):**
  - activation from a slip;
  - login with "keep me signed in";
  - switch between two children;
  - attendance month;
  - open a report card PDF;
  - open a receipt PDF;
  - read a notice and see its notification cleared;
  - submit a UPI claim (6C);
  - sign out other devices;
  - **URL tampering with Parent B's child id → 404 page**;
  - portal user typing `/erp/fees` → redirected.
- **Load / budget (Test, synthetic data):** simulate 500 families × 3 page views across an evening window, and record Neon awake hours and CU estimate from the Neon usage page against the 100 CU-h/month budget (FREE_TIER §Neon compute). This decides P20.

---

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **IDOR / cross-family data exposure**, the defining risk of this phase | Request-time children in AuthContext; one pure helper; separate `*.portal.ts` functions; NotFound without an oracle; table-driven IDOR suite; source-scan guard; security review per sub-phase |
| R2 | **Neon Free compute exhausted.** Families use the portal evenings and weekends, keeping compute awake beyond school hours (~0.25 CU × awake hours; 100 CU-h/month) | Data cache with tag invalidation; bounded queries; no polling (no auto-refresh, no unread-count polling — the count renders on navigation); measure in 6B-M4; P20 optional auth cache; monitor at 80 % |
| R3 | **Account takeover via lost or shared slips** | Expiring single-use codes, DOB check, attempt lock, the parent sets their own password, "sign out other devices", office reset issues a new code (old one dead) |
| R4 | **Duplicate Guardian rows** split siblings or give two accounts for one person | Link-existing-guardian and merge tools (P18); provisioning flags phone collisions; username = phone uniqueness surfaces duplicates |
| R5 | **Custody / safeguarding** (a parent barred by court order) | `portalAccess` block per child, effective next request, no notification sent to that guardian |
| R6 | **Leak of internal fee text** (KI-105 waiver reasons, concession and cancel reasons) | P15 columns; whitelist serializer; tests asserting on serialized output |
| R7 | Staff-parent role mixing widens scopes or sessions | ADR-045 exclusivity + DB CHECK on link columns + tests |
| R8 | **Fake UPI claims** | Confirmation only by an Accountant against the bank statement; UTR unique across claims and payments; confirm ≠ submitter; reject with reason; claims never mark anything paid by themselves |
| R9 | **Email cap** (90/day) during the launch week | Slips are the primary channel; invitations queue with a visible count; no event emails |
| R10 | Notification fan-out spikes (result day) | `createMany` batches after commit, dedupe key, 90-day retention |
| R11 | Role edits by a Super Admin silently widen portal roles | Allowlist check in provisioning + catalog invariant tests; `ALLOWED_SCOPES` principle (S-08) |
| R12 | Scope creep (chat, push, apps, gateway) | P19, P21, P23 and §9 keep them out explicitly |
| R13 | DPDP Act compliance (children's data) | Consent captured with version at activation; data minimisation (P9 whitelist); student accounts only after parent activation; leaver deactivation |
| R14 | Verification debt (KI-059) | 6A-M4 / 6B-M4 cannot close with unrun suites |

**KIs to open:** guardian merge edge cases; web push (future); two-way messaging (future); gateway (if deferred again, reference ADR-042); Hindi UI for the portal (i18n is centralised, not translated); the P20 auth-cache trade-off if adopted.

---

## 9. Out of scope (Phase 6)

- Two-way messaging or chat between parents and teachers, and parent-to-parent anything.
- SMS, WhatsApp, voice calls, web / mobile push, native apps (a basic web app manifest is allowed only if the ui-ux-designer asks; no service worker caching of private data).
- A live online payment gateway (unless the owner opts in under P19). Refunds; advance / credit balances (FC9).
- Parents editing student data, uploading documents, or applying for leave on behalf of students. Online admission applications by parents (Phase 8 enquiry form only).
- Transport tracking, library (Phase 7), certificates requests (Phase 7).
- 2FA for portal accounts. Self-registration.
- Report-card verification codes (KI-090) and receipt verification codes (FC14): unchanged.
- Translation of the portal UI.

---

## 10. Questions for the school (missing requirements)

1. How many families and students, and what share of parents have a smartphone and an email address? (This sizes slips against email invitations and the R2 load.)
2. Do both parents want separate logins, or the primary guardian only at launch?
3. How are slips best distributed: PTM, admission desk, sealed envelope in the diary?
4. Are there custody restrictions today that the office must enforce from day one?
5. Should students have their own login, and from which class? Should students see fees? (Recommended: no.)
6. Which notices go to families today (circulars, PTM, holidays, fee reminders), and who writes them? Should class teachers post to their own section?
7. Does the school already publish a UPI ID or QR for fees, and who matches UTRs against the bank statement? How fast is confirmation expected (same day)?
8. Should parents be told of absence the same day? (Recommended: yes, in-app.)
9. How long should a family that has left keep access to report cards and receipts? (Recommended: 180 days.)
10. Is the school's privacy notice for parents available? (Its text and version are needed for activation consent.)
11. Is a Hindi or regional-language portal needed at launch?
12. How many staff are also parents of current students? (This determines second-account volume under P3.)

---

## 11. Security checklist (portal-specific)

- **IDOR:**
  - Every family read takes a student (or child-owned record) id from untrusted input and resolves it through `assertPortalStudent` **after** loading the owning studentId.
  - "Missing" and "not yours" give an identical 404.
  - The table-driven suite covers every route, action and API.
- **Enumeration:**
  - `/login` keeps the generic error.
  - `/activate` returns one message for unknown username, wrong code, expired code, superseded code and DOB mismatch.
  - Username collisions in provisioning never show the other account's details.
  - No endpoint confirms whether a phone number or child exists.
- **Account takeover:**
  - Codes are single use, 21 days, newest only, SHA-256 stored, never logged or audited, never in a query string (fragment + POST).
  - Lock after 5 failed activation attempts per user. The office reset revokes all sessions and old codes.
  - Password policy unchanged (≥ 10, common-list).
  - `portal.account.manage` can't touch staff or Super Admin accounts. The PARENT / STUDENT role allowlist is checked before every provisioning.
- **Shared family phones:**
  - "Keep me signed in" is unticked by default.
  - Sign out is always visible; "sign out other devices" exists.
  - No sensitive data in notifications' bodies (titles like "New report card for Ananya", no marks or amounts).
  - PDFs are served `private, no-store`, `Content-Disposition: attachment` with a non-identifying filename.
- **Session fixation:**
  - A new session token at login and at activation (never reuse a pre-auth cookie). Activation creates the session only after the password is set.
  - Password change and office reset revoke other sessions (existing).
  - The `__Host-` cookie prefix is kept.
- **Long sessions:** 30-day idle and absolute only for portal-only accounts (ADR-045 + tests). Deactivation and leaver cron delete sessions.
- **Rate limits:**
  - The public `/login` and `/activate` are limited per IP and per user (the activation rules are new) and do **no DB work before the IP limit** (Neon).
  - `portalPdf`, `paymentClaim` and `noticeCompose` are per-user rules.
- **CSP:**
  - Portal pages render dynamically with the nonce (ADR-024).
  - No new third-party origins (the UPI QR is served from own storage; a `upi://` deep link needs no CSP change).
  - If a gateway is ever enabled, its checkout origin goes into `src/lib/csp.ts` explicitly (`script-src` / `frame-src`) with its own review.
- **No admin navigation:** the portal layout imports no ERP nav. ERP layout and pages redirect portal accounts. Static guard tests.
- **Data minimisation:**
  - Explicit portal `select` whitelists. Never documents, reasons, internal remarks, other guardians' contacts or staff personal data (teacher display name only).
  - Aadhaar / medical: not collected today. If ever added, never in the portal without a new decision.
- **CSRF:** server actions (Origin check); portal API routes are same-origin GET for PDFs and POST with an Origin check for claims.
- **Audit:**
  - Provisioning, activation (without code or DOB), link / merge / block, claim submit / confirm / reject (no amount in audit, as with collections), notice publish / withdraw, leaver deactivation.
  - Portal **reads** are not audited per view, except PDF downloads (receipt, report card), which are audited as views.
- **Escalation:** security-auditor reviews at 6A-M4 (auth, sessions, RBAC, activation), 6B-M3 (fees exposure, cache keys), 6C-M1 (uploads in notices) and 6C-M3 (payments).

---

## 12. ADRs to record (SYSTEM_ARCHITECTURE §2)

| ADR | Decision | Rationale | Rejected |
|---|---|---|---|
| **ADR-044** | Portal scope resolved **once per request** into `AuthContext.portal` (children from `StudentGuardian` where `portalAccess`, own studentId) and checked by a pure `lib/rbac/portal-scope` helper using scope **membership**, not the widest scope | One query, immediate revocation, no cross-module cycles, pure and testable | A per-module resolver (cycles, N queries); a portal module reading foreign tables; a cross-request children cache |
| **ADR-045** | **Portal accounts are exclusive:** PARENT or STUDENT alone, never with staff roles; separate `/portal` shell; long sessions only for portal-only accounts; DB CHECK on the link columns | Removes scope masking (`scopeFor`) and 30-day staff sessions; clear UX | Mixed accounts with a role switcher |
| **ADR-046** | **Office-issued activation codes** (slip / optional email, fragment, DOB check, consent) and `portal.account.manage` with a role allowlist instead of generic `user.manage` | No SMS, 90 emails a day, Indian parents often without email; safe delegation to School Admin | Self-registration; printed temporary passwords (no expiry); giving School Admin `user.manage` |
| **ADR-047** | **Internal notices** are their own module (`notice`, audience targets, read receipts), separate from Phase 8 public CMS notices; in-app notifications module with a dedupe key, enqueued after commit | Families and staff need targeted, private notices before the website exists | Reusing `Notification` rows as notices (fan-out of every notice) |
| **ADR-048** | **UPI payment intimation** (parent submits UTR, Accountant confirms through the counter path) as the free portal payment; gateway remains ADR-042, opt-in only | Free-only policy; no merchant fees; matches how many schools already work | A live gateway by default |

---

## 13. Completion criteria

1. The 6A / 6B / 6C integration suites, **including the full IDOR suite**, are green on Neon Test.
2. Portal e2e journeys pass at 360 / 768 / 1280 px with axe clean.
3. The RBAC matrix is regenerated and the catalog sync (89 / 13 / 320, or as decided) is applied to development and Test with approval.
4. The Neon load measurement is recorded against the budget.
5. Security reviews are done at each gate in §11.
6. `lint`, `typecheck`, `check:deps` and `test` all pass; CI is green.
7. Docs are updated:
   - DATABASE_SCHEMA, DATABASE_RELATIONSHIPS;
   - AUTHENTICATION_AND_RBAC (account kinds, activation, portal scopes), RBAC_MATRIX;
   - SECURITY;
   - API_DOCUMENTATION (portal routes);
   - UI_UX_GUIDELINES (portal shell);
   - FREE_TIER (portal load, email use);
   - ENVIRONMENT_VARIABLES (no new secrets unless a gateway is opted in);
   - ADR-044…048;
   - DEVELOPMENT_ROADMAP §8, KNOWN_ISSUES (KI-101 closed or narrowed, KI-105 closed, KI-057(3) closed), DEVELOPMENT_PROGRESS, CHANGELOG.

---

**Follow-ups for other agents:**
- **database-engineer:** table-level design of migrations A–C and the KI-105 backfill SQL.
- **ui-ux-designer:** portal shell, child switcher, attendance calendar, ledger cards, UPI page and activation slip layout.
- **security-auditor:** the gates in §11.

**Files cited:**
- `prisma\schema.prisma` (User 31-108, Notification 496-517, Guardian 737-753, StudentGuardian 755-771, ReportCard 1887-1909, Homework 1961-1984, FeePayment 2365-2402)
- `src\lib\rbac\catalog.ts` (198-215, 308-325, 339-349)
- `src\lib\rbac\authorize.ts` (7-24, 51-56)
- `src\lib\auth\session.ts` (15-19, 53-107)
- `src\lib\auth\context.ts` (28)
- `src\modules\identity\auth.service.ts` (28, 80)
- `src\modules\identity\users.service.ts` (10-11, 132-159, 229-246)
- `src\modules\identity\identity.policy.ts` (40-98)
- `src\modules\identity\password-reset.service.ts` (20-26, 53)
- `src\modules\students\students.policy.ts` (12-20)
- `src\modules\students\student-attendance.service.ts` (47-54)
- `src\modules\fees\fees.policy.ts` (7-12)
- `src\modules\fees\invoices.service.ts` (311-335)
- `src\modules\academic\results.service.ts` (25-27, 48-61, 398)
- `src\modules\academic\homework.service.ts` (23), `src\modules\academic\timetable.service.ts` (14), `src\modules\academic\calendar.service.ts` (14, 27)
- `src\modules\hr\staff-accounts.service.ts` (40-51)
- `src\components\erp\nav-items.ts` (43-48, 90-97)
- `src\app\erp\layout.tsx` (14-17)
- `src\app\(auth)\login\actions.ts` (31)
- `src\lib\rate-limit.ts` (15-42)
- `docs\PHASE_5_PLAN.md`, `docs\KNOWN_ISSUES.md`, `docs\SYSTEM_ARCHITECTURE.md`, `docs\FREE_TIER.md`, `docs\AUTHENTICATION_AND_RBAC.md`

**Points I did not check:**
- The 312-grant baseline is taken from KI-101; run `npm run rbac:matrix` before the catalog change.
- I did not read the receipt and allocation immutability trigger SQL. The KI-105 backfill and any migration D must be checked against it.
- I did not check whether `check:deps` flags the existing `identity → academic` import as a cycle risk once students → identity calls are added.