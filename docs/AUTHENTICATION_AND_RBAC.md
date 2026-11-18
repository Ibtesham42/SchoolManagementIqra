# Authentication and RBAC

## 1. Authentication

| Aspect | Design |
|---|---|
| Credentials | Username/email + password. Parents/students may log in with a username issued by the school (many parents share emails). |
| Hashing | Argon2id (`@node-rs/argon2`), memoryCost 19 MiB, timeCost 2, parallelism 1 (OWASP baseline). Rehash on login if params change. |
| Session | 32-byte random token in cookie `__Host-sid` over HTTPS (`sid` on plain-HTTP localhost) — `HttpOnly; Secure; SameSite=Lax; Path=/`. DB stores **SHA-256 of token** only. |
| Lifetime | Idle 8 h for staff, 30 days for parent/student "remember me"; **absolute 30 days from sign-in**. Sliding renewal when < half the idle lifetime remains (`nextSessionExpiry`, unit tested); renewal never grows the idle lifetime. `lastSeenAt` marks the start of the current idle window, not the last request. |
| Revocation | Deactivation, password change, password reset (self-service or by admin) delete the user's sessions. Role/permission changes need no revocation: permissions are loaded on every request, so they apply on the next page load. "Sign out other devices" (My account) and "Sign out of all devices" (Users → user) are available. |
| Lockout | 5 failed attempts / 15 min per account → temporary lock (15 min), audit entry. Rate limits (S-03, 2026-11-10): per IP 20 attempts / 15 min; per **(username, IP)** 10 attempts / 15 min; per username **failed** attempts 30 / 15 min (checked before any work; successful logins don't count) — so nobody can keep a user out from another address by spending a shared bucket. Admin unlock, admin password reset and a completed reset clear the account lock **and** the user's limiter buckets. Password change has its own per-user bucket. Generic error message ("Invalid credentials"). Residual by design: 5 wrong passwords still lock the account for 15 min (admin unlock ends it). |
| Password policy | ≥ 10 chars, checked against a common-password list; no forced rotation. First-login forced change for admin-issued passwords. |
| Reset | `/forgot-password`: identical response whether or not the account exists; rate limited per IP and per identifier (5/hour). Single-use token (SHA-256 in DB, 30 min, only the newest link works) delivered in the URL **fragment** (`/reset-password#token=…`) so it never reaches server/proxy logs; the page strips it from history and POSTs it. Lookup and email run after the response (`after()`) so timing doesn't reveal account existence. Page served with `Referrer-Policy: no-referrer`. Completing a reset ends all sessions. Users without email: admin "Reset password" issues a one-time temporary password (shown once, never stored in plain text) and forces a change. |
| CSRF | Server actions: Next.js Origin check. Route handlers with cookies: verify `Origin`/`Host` match on non-GET. Webhooks: no cookie, signature-verified. |
| 2FA | Planned (TOTP) for Super Admin, Accountant, HR — see ROADMAP. |

## 2. Authorization model

```
User ─< UserRole >─ Role ─< RolePermission >─ Permission(key)
                         └─ scope per permission: ALL | ASSIGNED | SELF | CHILDREN
```

- `authorize(ctx, key)` — does any of the user's roles grant `key`? Returns the **widest scope** granted.
- Policies narrow by scope:
  - `ASSIGNED` — teacher's allocated class/sections/subjects for the current session (class teacher: their section).
  - `SELF` — the user's own Employee/Student record.
  - `CHILDREN` — students linked via `StudentGuardian` to the parent user.
- Super Admin role is flagged `isSystem` and bypasses checks; it cannot be deleted or have permissions removed, and the last active Super Admin cannot be deactivated.
- Roles other than Super Admin are editable in **Settings → Roles & Permissions**. Every change is audited.

## 2a. Administration rules (implemented — `src/modules/identity/identity.policy.ts`)

| Rule | Enforced by |
|---|---|
| The `SUPER_ADMIN` role is a system role: permissions, key and name immutable; cannot be deleted. | `assertCanEditRole`, `assertCanDeleteRole` |
| Only a Super Admin may assign or remove the Super Admin role, or modify/deactivate/reset a Super Admin account. | `assertCanModifyUser`, `assertCanAssignRoles` |
| A Super Admin cannot remove the role from their own account; nobody can deactivate themselves. | `assertCanAssignRoles`, `assertCanDeactivate` |
| At least one active Super Admin always remains, under concurrent changes too: every transaction that can change Super Admin membership first takes a transaction-scoped advisory lock (row locks on a join are insufficient under READ COMMITTED). | `assertKeepsASuperAdmin` + `lockSuperAdminGuard` |
| **Anti-escalation:** a non–Super Admin holding `user.manage`/`role.manage` can only assign roles, or grant/revoke permissions, that they hold themselves at a covering scope, and cannot edit a role they hold. | `actorCovers`, `assertGrantsWithinActor`, `assertCanEditRole` |
| **No account takeover:** a non–Super Admin may only modify (edit, reset password, unlock, deactivate, sign out) users whose **entire** permission set they hold. Consequence: to delegate account administration for, say, teachers, the delegate must also hold the Teacher role's permissions; otherwise keep it with the Super Admin. | `assertCanModifyUser` |
| Scope coverage is a partial order: `ALL` covers everything; a scope covers itself; any scope covers `SELF`; `ASSIGNED` and `CHILDREN` don't cover each other. | `scopeCovers` |
| A pending forced password change blocks every permissioned operation (even for Super Admin). | `authorize`, `hasPermission` |
| Every change is audited in the same transaction (before/after, secrets redacted). | `lib/audit` |

The UI disables options the policy would reject (same functions), but the server re-checks everything.

## 3. Permission catalog (`module.action`)

| Module | Permissions |
|---|---|
| Users/Roles | `user.read` `user.manage` `role.manage` |
| Settings | `settings.read` `settings.manage` `session.manage` `template.manage` |
| CMS | `cms.read` `cms.edit` `cms.publish` `enquiry.read` `enquiry.manage` |
| Admissions | `admission.read` `admission.create` `admission.approve` |
| Students | `student.read` `student.create` `student.update` `student.delete` `student.sensitive.read` (Aadhaar, medical) `student.document.read` `student.document.manage` (upload/replace/verify/remove student & admission documents — Phase 2B) `student.promote` `student.transfer` `discipline.manage` |
| Roll numbers | `rollnumber.generate` `rollnumber.finalize` `rollnumber.correct` |
| ID cards/Docs | `idcard.generate` `document.generate` `certificate.issue` |
| HR | `employee.read` (directory) `employee.personal.read` (personal details & documents — Phase 3A, H6) `employee.manage` `employee.document.manage` (Phase 3A, H8) `employee.sensitive.read` (PAN/bank — reserved for payroll 3C) `leave.request` `leave.approve` |
| Attendance | `attendance.student.mark` `attendance.student.read` `attendance.employee.mark` `attendance.employee.read` |
| Payroll | `payroll.read` `payroll.prepare` `payroll.approve` `payroll.pay` `salary.structure.manage` `salary.self.read` |
| Fees | `fee.structure.manage` `fee.read` `fee.collect` `fee.concession.manage` `fee.refund` `fee.report` |
| Transport | `transport.read` `transport.manage` `transport.assign` |
| Academics | `academic.read` (view classes & sections; ASSIGNED = own class-teacher sections, ADR-034) `academic.manage` `timetable.manage` `exam.manage` `marks.enter` `marks.approve` `result.publish` `reportcard.generate` |
| Library | `library.read` `library.manage` `library.issue` |
| Inventory | `inventory.read` `inventory.manage` |
| Import/Export | `import.run` `export.run` (each export additionally needs the module's read permission; sensitive columns need `*.sensitive.read`) |
| Chatbot | `chatbot.manage` `chatbot.analytics` |
| System | `audit.read` `backup.manage` `integration.manage` `notification.send` |

## 4. Default role matrix (seeded; Super Admin can edit)

Scope shown in brackets; no bracket = ALL.

| Role | Key grants |
|---|---|
| Super Admin | everything (system role) |
| School Admin | user.read, settings.read, **settings.manage, session.manage** (school profile, logo, regional settings, academic sessions — owner decision 2026-11-09), cms.*, admission.* (incl. **admission.approve**), student.* (no sensitive; incl. **student.document.manage**), rollnumber.generate, idcard.generate, document.generate, employee.read, **employee.manage, employee.personal.read, employee.document.manage** (Phase 3A — Q1/H6/H8, 2026-11-10), attendance.*.read, fee.read, transport.read, academic.read, academic.manage, library.read, inventory.read, export.run, import.run — **trimmed by Super Admin as needed** |
| Principal | read on all academic/student/employee modules (incl. academic.read), **admission.approve** (approver with School Admin — D2, 2026-11-10), student.sensitive.read, **employee.personal.read** (Phase 3A, H6), leave.approve, marks.approve, result.publish, rollnumber.finalize, certificate.issue, payroll.approve, fee.report, cms.publish, audit.read |
| Vice Principal | Principal minus payroll.approve, audit.read |
| Accountant | fee.*, payroll.read, payroll.prepare, payroll.pay, transport.read, export.run (fee/payroll) |
| HR Manager | employee.*, leave.approve, attendance.employee.*, salary.structure.manage, payroll.prepare, payroll.read |
| Admission Officer | admission.read, admission.create (**prepares and submits — never approves**, D2), student.read/create/update, student.document.read, **student.document.manage**, enquiry.*, rollnumber.generate, idcard.generate, document.generate, academic.read (class/section list for admissions) |
| Teacher | student.read [ASSIGNED], attendance.student.mark [ASSIGNED], marks.enter [ASSIGNED], timetable read, leave.request, salary.self.read [SELF], library.read, academic.read [ASSIGNED] |
| Class Teacher | Teacher + attendance.student.mark/read for own section, discipline.manage [ASSIGNED], student.update (contact fields) [ASSIGNED] |
| Transport Manager | transport.*, student.read (name/class/stop only) [ASSIGNED via route] |
| Librarian | library.*, student.read (basic), employee.read (directory fields only — Q3; no personal tier) |
| Parent | student.read [CHILDREN], attendance.student.read [CHILDREN], fee.read [CHILDREN], results [CHILDREN], online fee payment [CHILDREN], notices |
| Student | own profile/attendance/results/timetable/library history [SELF] |

> **System-level authority stays with Super Admin**: `user.manage`, `role.manage`, `backup.manage`, `chatbot.manage` and `audit.read` (Principal too) are not granted to School Admin, and `settings.manage` covers only school-level data (profile, logo, regional, timings). Integration toggles, provider settings and usage caps (`SchoolSetting.features`) must get their own Super Admin–only permission when a screen for them is built — never `settings.manage`. **One school per installation** (ADR-002, confirmed by ADR-030): each school has its own deployment, database, storage and keys, so there is no tenant boundary inside the app. Super Admin is the top authority *of that installation*.
>
> **Classes & sections** (Phase 2, ADR-034): `academic.manage` (Super Admin, School Admin) is the only write permission. Assigning a class teacher widens that teacher's ASSIGNED scope to the section — not an escalation (the permissions come from the teacher's own role; the assigning admin holds them at ALL) and audited. Eligible class teachers: active users holding the TEACHER or CLASS_TEACHER system role. Re-seeding an existing database gives a permission that is new in that run its catalog default grants on existing roles too (`newPermissionGrants`, seed core); existing grants are never changed.
>
> **Admissions (Phase 2B, D2)**: approvers are School Admin and Principal (`admission.approve`); the Admission Officer prepares and submits (`admission.create`) and manages documents (`student.document.manage`) but never approves — maker-checker. Teachers, Accountant, Parent and Student hold no admission or document permission (Accountant keeps its existing `student.read`, D8). Seed note: `student.document.manage` is new, so a re-seed adds it to School Admin and Admission Officer on an existing database; Principal's `admission.approve` is an existing permission and is **not** added by the seed (existing grants are never changed) — a Super Admin grants it in Roles (audited) or through a separately approved step.
>
> **Documents**: `document.generate` (issue) and `document.revoke` (invalidate; Super Admin and Principal by default) are separate — holding one never implies the other.

Note: a user may hold several roles (e.g. Teacher + Class Teacher); grants union, widest scope wins.

## 5. Enforcement checklist (every endpoint)

1. Session required (except public routes & webhooks).
2. `authorize` with the exact permission.
3. Policy check against the specific record IDs in the request (prevents IDOR).
4. Response shaped by a field-level serializer that drops sensitive fields lacking `*.sensitive.read`.
5. Integration test proving a forbidden role gets 403 (see TESTING_STRATEGY.md).

## Scopes the role editor offers (S-08, 2026-11-10)

`ALLOWED_SCOPES` in `src/lib/rbac/catalog.ts`: every permission can be granted for **all records**; a narrower scope only where the catalog's default roles use it (the owning module implements it or, for portal scopes not built yet, refuses it) — today `student.read`, `student.update`, `academic.read`, `discipline.manage`, `attendance.student.*`, `marks.enter`, `result.read`, `fee.read`, `fee.pay.online`, `timetable.read`, `library.read`; `salary.self.read` is **SELF only**. The editor shows only these; `setRolePermissions` refuses a new or changed grant outside them (an unchanged older grant is left alone). A module that starts honouring a new scope must be added there with its policy and tests. Class-teacher (ASSIGNED) access ends when the section's session is CLOSED (S-02) and when the user loses the TEACHER / CLASS_TEACHER role (S-09).

