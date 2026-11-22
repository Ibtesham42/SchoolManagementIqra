# Database Schema (design — Phase 0)

PostgreSQL 16+ (Neon Free), Prisma 7, extension `vector` (pgvector). `prisma/schema.prisma` is the source of truth; this document must be kept in sync.

**Implemented (Phase 1, migration `20261108000000_init`, 15 tables):** User, Session, PasswordResetToken, Role, Permission, RolePermission, UserRole, SchoolSetting, AcademicSession, SequenceCounter, StoredFile, AuditLog, Notification, RateLimitBucket, UsageCounter. Everything else below is still the plan for later phases.

**Phase 2, migration `20261110000000_phase2_classes_sections` — applied to the development branch 2026-11-10 05:20Z (owner-approved; drift exit 0, `db:check` ✓); test branch pending:** SchoolClass, Section (→ 18 tables), `SchoolSetting.defaultSectionCapacity`. The Section partial unique index is expressed in the schema via the `partialIndexes` preview feature (ADR-034), so drift checks keep it.

Phase 1 deviations from the original plan (to avoid raw-SQL partial indexes that Prisma's diffing would try to drop):
- `User.email` is stored lowercased with a plain unique constraint (NULLs allowed) instead of a `lower(email)` partial index.
- `AcademicSession.isCurrent` was replaced by `SchoolSetting.currentAcademicSessionId` (unique FK) — guarantees at most one current session.
- **S-15 (migration `20261118000100_stored_file_purged_at`, applied to development and Test 2026-11-18):** `StoredFile.purgedAt?` (timestamptz) set by the purge job after deleting a retired file's blob (30-day grace); CHECK `purged_at IS NULL OR (deleted_at IS NOT NULL AND purged_at >= deleted_at)`. **S-07 (migration `20261118000000_audit_log_append_only`, applied to development and Test 2026-11-18):** triggers refuse UPDATE/DELETE/TRUNCATE on `audit_log`.
- New: `StoredFile.provider`, `encrypted`, `keyVersion` (ADR-018); `RateLimitBucket` and `UsageCounter` (ADR-019); `AuditLog.id` is a BigInt identity.

## Conventions

- PK: `id String @id @default(cuid(2))` (unguessable; no enumeration). Human-facing numbers (admission no., receipt no.) are separate unique columns.
- Every table: `createdAt timestamptz default now()`, `updatedAt @updatedAt`. Mutable records also have `createdById`/`updatedById` → User.
- Soft delete: `deletedAt timestamptz?` on models marked **(SD)**. Unique constraints that must ignore deleted rows use partial unique indexes (raw SQL in migration).
- Money: `Decimal @db.Decimal(12,2)`. Dates without time: `@db.Date`.
- Enums are Postgres enums unless the value set is school-configurable (then a lookup table).
- Session-scoped tables carry `academicSessionId` (FK, indexed).

Legend: **PK** primary key · **U** unique · **IX** index · **FK** foreign key

## 1. Identity & access

| Model | Key fields | Constraints / indexes |
|---|---|---|
| User (SD) | username, email?, passwordHash, isActive, mustChangePassword, lastLoginAt, failedLoginCount, lockedUntil, employeeId?, studentId?, guardianId?, privacyConsentAt?, privacyConsentVersion? | U(username), U(lower(email)) partial where not null, U(employeeId), U(studentId), U(guardianId). **Phase 6A (migration `20261126000000`, applied to development and Test 2026-11-22):** studentId → Student and guardianId → Guardian become FKs (RESTRICT); CHECK `user_one_person` (at most one of employee / student / guardian — ADR-045); CHECK consent at + version both or neither |
| AccountActivation (Phase 6A) | userId → User (CASCADE), codeHash, channel (SLIP / EMAIL), expiresAt, usedAt?, failedAttempts, createdById? → User (SET NULL) | U(codeHash), IX(userId), IX(expiresAt); CHECK expires_at > created_at, failed_attempts ≥ 0. Single-use portal activation codes (P4, P6); only the hash is stored |
| Session | tokenHash, userId, expiresAt, lastSeenAt, ip, userAgent | U(tokenHash), IX(userId), IX(expiresAt) |
| PasswordResetToken | tokenHash, userId, expiresAt, usedAt | U(tokenHash) |
| Role | key, name, description, isSystem | U(key) |
| Permission | key, module, description | U(key) |
| RolePermission | roleId, permissionId, scope (ALL/ASSIGNED/SELF/CHILDREN) | PK(roleId, permissionId) |
| UserRole | userId, roleId | PK(userId, roleId) |

## 2. Settings & core

| Model | Key fields | Constraints |
|---|---|---|
| SchoolSetting | singleton (`id = 'default'`): name, shortCode, affiliationNo, board, address JSON, phones, email, logoFileId → StoredFile (FK, ON DELETE SET NULL), timezone, **locale** (default `en-IN`), **currency** (default `INR`), **dateFormat** (default `DD/MM/YYYY`; allowlist in settings.schemas), **defaultSectionCapacity** (SmallInt, default 40, CHECK 1–200 — a default for new sections, not a limit; migration `20261110000000`, applied to **development** 2026-11-10 05:20Z; test pending), timings JSON, branding JSON, idFormats JSON, rollNumberRules JSON, chatbot/notification/backup/integration JSON (no secrets) | — |
| AcademicSession | name ("2026-27"), startDate, endDate, isCurrent, status (PLANNED/ACTIVE/CLOSED) | U(name); partial U(isCurrent) where true |
| SequenceCounter | key (e.g. `student_id:2026`), value Int | PK(key) — updated via `UPDATE … SET value = value + 1 RETURNING value` |
| StoredFile | storageKey, originalName, mimeType, sizeBytes, sha256, visibility (PUBLIC/PRIVATE), encrypted, keyVersion, uploadedById, **purpose** (UPLOAD_RULES key; `unclassified` for pre-2a rows, owner `LegacyFile`/<own id>, Super Admin only), **ownerType/ownerId** (owning record, polymorphic), deletedAt | U(storageKey), IX(sha256), IX(visibility), IX(ownerType, ownerId); CHECKs (all validated): private ⇒ owner set; private ⇒ encrypted with key_version; owner columns both set or both null |
| DocumentTemplate | kind (ID_CARD/CERTIFICATE/RECEIPT/SLIP/REPORT_CARD), name, config JSON, isDefault | IX(kind) |
| GeneratedDocument | type (ID_CARD/CERTIFICATE/RECEIPT/REPORT_CARD/SALARY_SLIP/OTHER), **verificationCodeHash** (HMAC-SHA256 hex with `DOCUMENT_VERIFICATION_KEY` — raw code never stored), **verificationKeyVersion** (SmallInt ≥ 1, no default), subjectType/subjectId (polymorphic), fileId → StoredFile (PRIVATE PDF; ON DELETE RESTRICT), generatedById → User (SET NULL), generatedAt, revokedAt?, revokedById → User (SET NULL), revocationReason? | U(verificationCodeHash), U(fileId), IX(subjectType, subjectId), IX(type, generatedAt); CHECK hash is 64 lowercase hex; CHECK key version ≥ 1; CHECK revoker/reason only when revoked. *(Implemented in migration `20261109000000`, awaiting approval; `serialNo` deferred to the first numbered document type.)* |

## 3. Academics

**Phase 4A: migration `20261121000000_phase4a_teaching_attendance` (owner-approved 2026-11-19; **applied to development** 10:36Z, drift 0; Test pending KI-059).** Design: PHASE_4_PLAN.md (AC1–AC20 approved 2026-11-19), ADR-038. Offline diff + hand edits: one transaction, `lock_timeout`, 16 CHECKs. Expand-only; existing tables gain `school_setting.student_weekly_off` (nullable JSONB + CHECK) and a unique index `student_enrollment(id, academic_session_id)` (composite-FK target). StudentAttendance is listed in §6.

| Model | Key fields | Constraints |
|---|---|---|
| SchoolClass | master data (not session-scoped, never deleted — deactivate): **code** (VarChar 10, e.g. `C06`, `C11-SCI`; immutable once a section uses it), name (VarChar 60, e.g. "Class 11 Science" — streams are separate classes), **nameKey** (= lower(name)), numericLevel (SmallInt −3…12; not unique), displayOrder, defaultSectionCapacity? (1–200), isActive, **version** (optimistic concurrency) | U(code), U(nameKey), IX(isActive, displayOrder); CHECKs: code `^[A-Z0-9]+(-[A-Z0-9]+)*$`, name printable ASCII trimmed/collapsed, name_key = lower(name), level −3…12, display_order ≥ 0, capacity null or 1–200, version ≥ 1. *(Migration `20261110000000`, applied to **development** 2026-11-10 05:20Z; test pending.)* |
| Section | academicSessionId → AcademicSession (RESTRICT), classId → SchoolClass (RESTRICT), name (VarChar 20, e.g. "A"), **nameKey** (= lower(name)), **code** (`<class code>-<NAME>`, e.g. `C06-A`), capacity (SmallInt 1–200, required; form → class default → setting default 40), **classTeacherId? → User** (RESTRICT; interim, ADR-034 — Phase 3 reaches Employee via User.employeeId), isActive, **version** | U(academicSessionId, classId, nameKey), U(academicSessionId, code), **partial U(academicSessionId, classTeacherId) WHERE classTeacherId IS NOT NULL**, IX(classId); CHECKs: name letters/digits with single spaces, name_key = lower(name), code format, capacity 1–200, version ≥ 1. Editable only in PLANNED/ACTIVE sessions (service). *(Migration `20261110000000`, applied to **development** 2026-11-10 05:20Z; test pending.)* |
| Subject | code, name (any script), nameKey, kind (SCHOLASTIC/CO_SCHOLASTIC), isActive, version | U(code), U(nameKey); code/name shape CHECKs. School-defined (AC2). *Phase 4A draft* |
| ClassSubject | academicSessionId, classId, subjectId, isOptional, sortOrder, version | U(session, class, subject); U(id, session) as composite-FK target. Maximum marks live on ExamSubject (4B). *Phase 4A draft* |
| StudentSubject | academicSessionId, enrollmentId, classSubjectId | U(enrollment, classSubject); composite FKs keep enrollment and class subject in one session (AC3). *Phase 4A draft* |
| TeacherAllocation | academicSessionId, sectionId, classSubjectId, employeeId → Employee | U(section, classSubject): one teacher per subject per section; composite FKs (section, class subject) with the session; IX(employee, session). Teacher = ACTIVE TEACHING employee with a linked login (service, AC4). *Phase 4A draft* |
| Period | academicSessionId, dayOfWeek (0–6), number (1–15), label?, kind (TEACHING/BREAK), startTime, endTime (time), version | U(session, day, number); CHECK end > start (AC5). *Phase 4A draft* |
| TimetableSlot | academicSessionId, sectionId, periodId (the day is on the period), classSubjectId, employeeId? | U(section, period); **partial unique** (employee, period) where employee not null: no teacher double-booking; composite FKs with the session. *Phase 4A draft* |

## 4. Students & admissions

**Applied to development 2026-11-10 06:19Z** — migration `20261111000000_phase2b_admissions_students` (owner-approved design PHASE_2B_STUDENTS_DESIGN.md, ADR-035; drift exit 0 after KI-055). Test branch not migrated yet. No Aadhaar or medical columns in Phase 2B (D6). Enums: AdmissionStatus (DRAFT/SUBMITTED/UNDER_REVIEW/APPROVED/REJECTED), Gender, GuardianRelation (FATHER/MOTHER/GUARDIAN/OTHER), StudentStatus (ACTIVE/TRANSFERRED/GRADUATED/WITHDRAWN), EnrollmentStatus (ACTIVE/PROMOTED/DETAINED/LEFT), StudentDocumentType (BIRTH_CERTIFICATE/TRANSFER_CERTIFICATE/PREVIOUS_MARKSHEET/PHOTO/OTHER), RollNumberBatchStatus, RollNumberSource (GENERATED/APPENDED/CORRECTED).

| Model | Key fields | Constraints |
|---|---|---|
| AdmissionApplication | applicationNo? (`APP-{SESSION}-{SEQ:4}`, on first submit), academicSessionId, classId, sectionId?, status, first/middle/last name, fullName, fullNameNormalized, dob, gender, phone?, email?, address JSON?, previousSchool JSON?, admissionDate?, duplicateMatches JSON?, duplicateOverride?, rejectionReason?, created/submitted/reviewStarted/decided timestamps + actors, studentId? (set by approval), version | U(applicationNo), U(studentId); IX(session, status), IX(fullNameNormalized, dob), IX(status, updatedAt); CHECKs: non-DRAFT ⇒ number; APPROVED ⇔ studentId (+ section, decidedAt, admissionDate); REJECTED ⇒ reason + decidedAt; dob ≥ 1990-01-01; 10-digit phone; version ≥ 1 |
| AdmissionGuardian | applicationId (CASCADE), relation, name, phone, altPhone?, email?, occupation?, isPrimary, isEmergencyContact, linkGuardianId? (reviewer-chosen existing Guardian, D9), sortOrder | partial U(application, relation) WHERE FATHER/MOTHER (schema predicate in canonical `= ANY (ARRAY[…])` form, KI-055); partial U(application) WHERE is_primary; IX(phone); CHECK phones |
| Student (SD) | studentCode, admissionNo (both permanent), names, fullNameNormalized, dob, gender, phone?, email?, address JSON?, previousSchool JSON?, status, admissionDate, admittedSessionId, version, deletedAt? | U(studentCode), U(admissionNo); IX(fullNameNormalized, dob), IX(status); CHECKs version, dob, name, phone, codes |
| Guardian (SD) | name, phone, altPhone?, email?, occupation?, deletedAt? | IX(phone); CHECK phones |
| StudentGuardian | studentId, guardianId, relation, isPrimary, isEmergencyContact | PK(student, guardian); partial U(student) WHERE is_primary |
| StudentDocument | applicationId?, studentId? (set by approval), type, fileId (owns its PRIVATE StoredFile: ownerType "StudentDocument"), label?, uploadedById?, verifiedById?/verifiedAt?, deletedAt? | U(fileId); partial U one current PHOTO per application / per student; CHECKs owner set, OTHER ⇒ label, verifier ⇒ verifiedAt |
| StudentEnrollment | studentId, academicSessionId, sectionId, status, enrolledOn, leftOn? | U(student, session); **composite FK (sectionId, academicSessionId) → Section(id, academicSessionId)**; IX(section, status), IX(session, status); CHECK leftOn |
| RollNumberBatch | sectionId, status, version, generated/finalized by + at | U(sectionId); CHECKs version, FINALIZED ⇒ finalizedAt |
| StudentRollNumber | batchId (CASCADE), enrollmentId, rollNumber (SmallInt), source | U(enrollmentId), U(batch, rollNumber); CHECK ≥ 1 |
| StudentStatusChange | studentId, fromStatus, toStatus, reason, effectiveDate, actedById? | IX(student, createdAt); CHECK from ≠ to, reason |
| SchoolSetting (change) | **requiredAdmissionDocuments** StudentDocumentType[] default {PHOTO, BIRTH_CERTIFICATE} (D10) | CHECK NOT NULL |
| Section (change) | — | **U(id, academicSessionId)** (target of the enrollment composite FK) |

*Not in Phase 2B (planned later):* DisciplineRecord (SD) — studentId, academicSessionId, date, category, description, actionTaken, recordedById; MedicalRecord (restricted, 1:1) and Aadhaar fields (encrypted + HMAC) — only with `student.sensitive.read`; a profile timeline reads AuditLog (no StudentHistory table).

## 5. HR

**Phase 3A HR core — migration `20261112000000_phase3a_hr_core` (SQL approved by the owner 2026-11-18; **applied to development 2026-11-18 08:19Z and Test 08:22Z**, drift exit 0 on both).** Design: PHASE_3_PLAN.md §3a (H1–H14), ADR-036, PHASE_3A_M1_SCHEMA_PROPOSAL.md. One school per installation (no `school_id`). No Aadhaar, PAN, bank or medical columns in 3A (H5) — PAN/bank arrive with payroll (3C), encrypted + HMAC. Enums: StaffType (TEACHING/NON_TEACHING), AppointmentType (PERMANENT/PROBATION/CONTRACT/PART_TIME/GUEST), EmploymentStatus (ACTIVE/ON_LEAVE/RESIGNED/TERMINATED/RETIRED), EmployeeDocumentType (PHOTO/RESUME/QUALIFICATION_CERTIFICATE/EXPERIENCE_LETTER/APPOINTMENT_LETTER/RELIEVING_LETTER/OTHER), ServiceEventType (JOINED/CONFIRMED/DEPARTMENT_CHANGED/DESIGNATION_CHANGED/APPOINTMENT_TYPE_CHANGED/REPORTING_CHANGED/TRANSFERRED/STATUS_CHANGED/RESIGNED/TERMINATED/RETIRED/REJOINED). Every FK RESTRICT except actor columns (SET NULL); 21 CHECKs; one transaction with `lock_timeout` 5 s and a pre-check that `user.employee_id` is empty. Guarded rollback: `ROLLBACK.sql.txt` in the migration folder (refuses while any HR row or linked account exists).

| Model | Key fields | Constraints |
|---|---|---|
| Department | code (VarChar 20), name (VarChar 80, any script, NFC), **nameKey** (app-built NFKC + Unicode lower case), isActive, version | U(code), U(nameKey); CHECKs code `^[A-Z0-9]+(-[A-Z0-9]+)*$`, name NFC-normalized + trimmed single spaces + no control/zero-width characters, name_key NFKC-normalized (same shape), version ≥ 1. Deactivated, never deleted once used (H9) |
| Designation | code, name, nameKey, **staffType**, isActive, version | as Department; an employee's staffType must equal the designation's (service rule) |
| Employee (SD) | **employeeCode** (permanent, `EMP-{YYYY}-{SEQ:4}`, joining year, `lib/sequence`), staffType, appointmentType, employmentStatus (default ACTIVE), first/middle/last name, fullName, fullNameNormalized, dob, gender, workPhone?, personalPhone, workEmail?, personalEmail?, address JSON? and emergencyContact JSON? (personal tier, H6), departmentId, designationId, reportsToId? (self), joiningDate, confirmationDate?, leavingDate?, leavingReason?, version, createdById?, deletedAt? | U(employeeCode); IX(fullNameNormalized), IX(staffType, employmentStatus), IX(departmentId), IX(designationId), IX(reportsToId); CHECKs version, code non-empty, name, 10-digit phones, dob ≥ 1940 and before joining, confirmation/leaving ≥ joining, leaving status ⇔ leaving date ⇔ reason (H11), no self-reporting (cycles: service, H10) |
| TeacherProfile | employeeId (PK, 1:1, TEACHING employees — service rule), qualifications JSON[] ≤ 10, professionalQualifications JSON[] ≤ 10, specializations VarChar(60)[] ≤ 10 (free text until Phase 4 subjects, H14), experienceYearsBefore (0–60), teacherRegistrationNo?, version | CHECKs version, experience, array sizes |
| EmployeeDocument | employeeId, type, fileId (owns its PRIVATE encrypted StoredFile: ownerType "EmployeeDocument"), label? (required for OTHER), uploadedById?, verifiedById?/verifiedAt?, deletedAt? | U(fileId); **partial U(employeeId) WHERE type = 'PHOTO' AND deleted_at IS NULL** (schema-expressed); IX(employeeId); CHECK OTHER ⇒ label |
| EmployeeServiceEvent | employeeId, eventType, effectiveDate, before JSON?, after JSON? (changed ids/codes/enum values only — never personal-tier values), remarks?, actedById? | IX(employeeId, effectiveDate). **Append-only at application level** (H12): no update/delete service path; a DB trigger is a separate S-07 decision |
| User (change) | **employeeId → Employee** (FK `user_employee_id_fkey`, RESTRICT; existing unique index reused) | Optional 1:1 link (H2); linking needs `employee.manage` + `user.manage`, audited |

*Phase 3B (attendance & leave) — migration `20261119000000_phase3b_attendance_leave` **SQL approved 2026-11-18; applied to development (16:50Z) and Test (16:52Z), drift 0** (PHASE_3B_PLAN.md, L1–L12 approved 2026-11-18). Final shape: LeaveType (code, Unicode name + nameKey, isPaid, annualQuota Decimal(4,1)?, allowHalfDay, carryForwardMax, appliesTo, isActive, version); LeaveBalance (employee × type × academic session; allotted / carriedForward / used Decimal(5,1) ≥ 0); LeaveRequest (from/to date, halfDay?, days Decimal(4,1) ≤ range, reason, status, decision fields; overlap prevented by the service under the employee row lock); EmployeeAttendance (U(employee, date), status, optional check-in/out times, source, leave link only on leave days, correction reason); Holiday (U(date, appliesTo)); AttendancePeriodLock (month = first day); SchoolSetting.weeklyOff JSON. 20 CHECKs, all FKs RESTRICT except actor columns. The rows below are the original Phase 0 sketch:*

| Model | Key fields | Constraints |
|---|---|---|
| LeaveType | code, name, annualQuota, isPaid, carryForward | U(code) |
| LeaveBalance | employeeId, leaveTypeId, academicSessionId, allotted, used | U(employee, leaveType, session) |
| LeaveRequest | employeeId, leaveTypeId, fromDate, toDate, halfDay, days Decimal(4,1), reason, status (PENDING/APPROVED/REJECTED/CANCELLED), decidedById?, decidedAt? | IX(employeeId, status) |

## 6. Attendance

| Model | Key fields | Constraints |
|---|---|---|
| StudentAttendance | academicSessionId, enrollmentId (composite FK with the session), date, status (PRESENT/ABSENT/LATE/HALF_DAY/EXCUSED), correctionReason? (personal tier), markedById?, version | U(enrollmentId, date), IX(academicSessionId, date) (AC6, AC7). *Phase 4A draft* |
| EmployeeAttendance | employeeId, date, status (PRESENT/ABSENT/LATE/HALF_DAY/ON_LEAVE/HOLIDAY), checkIn?, checkOut?, source (MANUAL/BIOMETRIC/IMPORT), leaveRequestId? | U(employeeId, date) |
| Holiday | date, name, appliesTo (ALL/STUDENTS/STAFF) | U(date, appliesTo) |

## 7. Payroll

**Phase 3C — migration `20261120000000_phase3c_payroll` (owner-approved 2026-11-19; **applied to development** 10:36Z, drift 0; Test pending KI-059).** Design: PHASE_3C_PLAN.md (P1–P16 + Q approved 2026-11-19), ADR-037. Generated offline (`migrate diff` between schema files), then hand-edited: one transaction, `lock_timeout` 5 s, 28 CHECKs, 3 partial unique indexes. Expand-only: 7 enums (SalaryComponentKind, SalaryCalc, EmployeeSalaryStatus, PayrollRunStatus, PayrollDayBasis, PayrollAdjustmentKind, SalaryPaymentMethod), 8 new tables; existing tables gain nullable columns only. Money `Decimal(12,2)`, day counts `Decimal(5,1)`. Every FK RESTRICT except actor columns (SET NULL). Salary advances (P9) deferred — no table.

| Model | Key fields | Constraints |
|---|---|---|
| SalaryComponent | code, name, nameKey, kind (EARNING/DEDUCTION), calc (FIXED/PERCENT_OF_BASIC), prorated, isActive, version | U(code), U(nameKey); code/name shape CHECKs (as departments). School-defined only — nothing seeded, no statutory logic (P1, P2) |
| SalaryStructure | name, nameKey, isActive, version | U(nameKey); name shape CHECKs |
| SalaryStructureItem | structureId → SalaryStructure, componentId → SalaryComponent, value (rupees or percent), sortOrder | U(structureId, componentId); value ≥ 0 (percent ≤ 100: service) |
| EmployeeSalary | employeeId, structureId, basic, effectiveFrom (first of month), status (PROPOSED/APPROVED/REJECTED/WITHDRAWN), proposedById?, decidedById?, decidedAt?, decisionNote?, version | IX(employeeId, effectiveFrom); **partial unique**: one PROPOSED per employee; one APPROVED per (employee, effectiveFrom). CHECKs: basic ≥ 0, day 1, decided ⇔ decidedAt, REJECTED needs a note. Maker-checker (P7); never edited once decided |
| PayrollRun | month (first day, unique), status (DRAFT/PREPARED/APPROVED/PAID), dayBasis?, employeeCount, totalGross, totalDeductions, totalNet, preparedById?/At?, approvedById?/At?, reopenCount, version | U(month); CHECKs: day 1, totals ≥ 0 and net = gross − deductions, PREPARED+ ⇒ prepared + dayBasis, APPROVED/PAID ⇔ approvedAt |
| PayrollSlip | runId, employeeId, employeeSalaryId, slipNo? (lib/sequence at approval), salarySnapshot JSON, dayBasis, monthDays, offRollsDays, lopDays, paidDays, earnings JSON, deductions JSON, gross, totalDeductions, net, version | U(runId, employeeId), U(slipNo); CHECKs: paid + LOP + off-rolls = month days, net = gross − deductions ≥ 0, JSON shapes. **Snapshot** — never recomputed from current structures |
| PayrollAdjustment | slipId, kind (BONUS/ARREARS/OTHER_EARNING/OTHER_DEDUCTION), amount, note (personal tier), createdById? | amount > 0; note ≥ 3 chars |
| SalaryPayment | slipId, amount, method (BANK_TRANSFER/CHEQUE/CASH/UPI), reference?, paidOn (date), paidById? | amount > 0; **partial unique** (method, reference) where reference not null; sum ≤ net (service) |
| Employee (+) | panEnc?, panHmac?, bankAccountEnc?, bankAccountHmac?, bankIfsc?, bankAccountName? | U(panHmac); CHECKs: ciphertext/HMAC in pairs, HMAC 64 lowercase hex, IFSC `^[A-Z]{4}0[A-Z0-9]{6}$`. `employee.sensitive.read` only (P8) |
| SchoolSetting (+) | payrollDayBasis? (WORKING_DAYS/CALENDAR_DAYS) | No default — payroll refuses to prepare until set (P3) |

## 8. Fees

**Phase 5A — migration `20261124000000_phase5a_fees` (**applied** to development and Test 2026-11-20, owner-approved; drift exit 0 on both; partial indexes declared in `schema.prisma` with `where: raw(...)`).** Design: PHASE_5_PLAN.md FC1–FC26 (approved 2026-11-20). Offline diff + hand edits: one transaction, `lock_timeout`, 9 partial unique indexes, 50 CHECKs, 2 immutability triggers (security review 5A M1). Expand-only: 12 enums, 13 new tables, no existing table changed. Money `Decimal(12,2)`. Per-student rows reference the enrollment by (studentId, academicSessionId) — already unique on student_enrollment — so a row can't name a student and an enrollment that disagree. Replaces the early draft (installmentPlan JSON, FeeReceipt table, PaymentGatewayEvent → Phase 6).

| Model | Key fields | Constraints |
|---|---|---|
| FeeCategory | code, name, nameKey, kind (REGULAR/ONE_TIME/TRANSPORT/LATE_FEE/OPENING_BALANCE/OTHER), appliesTo (ALL/NEW_ADMISSION/EXISTING), isActive, version | U(code), U(nameKey); code format; school-defined, nothing seeded (FC2) |
| FeeInstallment | academicSessionId, name, nameKey, dueOn (date), sortOrder | U(session, nameKey); U(id, session) (FC3) |
| FeeStructure | academicSessionId, classId, name, isActive, version | **Partial** U(session, class) WHERE is_active; frozen once used (FC5, service) |
| FeeStructureItem | structureId + session, categoryId, installmentId + session, amount | U(structure, category, installment); amount ≥ 0; Cascade from its structure only |
| FeeConcession / FeeConcessionCategory | code, name, kind (CONCESSION/SCHOLARSHIP/DISCOUNT/WAIVER), calc (PERCENT/FIXED), value · (concession, category) | value > 0, percent ≤ 100 |
| StudentConcession | (studentId, session) → enrollment, concessionId, status (PROPOSED/APPROVED/REJECTED/REVOKED), reason (personal tier, never audited), proposedBy/At, decidedBy/At | **Partial** U(student, session, concession) WHERE PROPOSED/APPROVED; decided ⇔ not PROPOSED; decider ≠ proposer when both are known (FC6) |
| LateFeeRule | academicSessionId, graceDays (0–365), calc (FLAT/PER_DAY/PERCENT), value, cap? (required for PER_DAY) | **Partial** U(session) WHERE is_active (FC7) |
| StudentFeeCharge | (studentId, session) → enrollment, installmentId + session, categoryId, amount > 0, source (MANUAL/TRANSPORT), sourceRef?, note, deletedAt? | **Partial** U(student, session, installment, sourceRef) WHERE TRANSPORT and live (FC18 hook) |
| FeeInvoice (SD) | invoiceNo, (studentId, session) → enrollment, kind (INSTALLMENT/OPENING_BALANCE), installmentId?, dueOn (snapshot), subtotal, concessionTotal, lateFee, total, paidAmount, status (ISSUED/PARTIAL/PAID/WAIVED/CANCELLED), issued / cancelled by + at, cancelReason, deletedAt | U(invoiceNo); **partial** U(student, session, installment) and U(student, session) for opening balances WHERE deleted_at IS NULL; total = subtotal − concession + late fee; paid ≤ total; status ⇔ amounts; cancelled ⇔ deleted, unpaid, with reason |
| FeeInvoice (+, migration `20261125000000_phase5a_invoice_structure`, **applied** to development and Test 2026-11-20, owner-approved) | structureId? → FeeStructure (composite with the session, RESTRICT) | CHECK kind INSTALLMENT ⇔ structureId set; IX(structureId). Freezes exactly the invoiced structures (KI-103) |
| FeeInvoiceItem | invoiceId, categoryId, kind (STRUCTURE/CHARGE/LATE_FEE/OPENING_BALANCE), description (snapshot), amount, concessionAmount, paidAmount, sortOrder, chargeId? | 0 ≤ concession ≤ amount; 0 ≤ paid ≤ amount − concession; CHARGE ⇔ chargeId; U(chargeId) |
| FeePayment (= receipt) | receiptNo, studentId, amount > 0, method (CASH/UPI/BANK_TRANSFER/CHEQUE/CARD), transactionRef?, instrumentDate?, bankName?, paidOn, idempotencyKey, collectedById?, receiptSnapshot JSON, status (SUCCESS/CANCELLED), cancelled by / at / reason, printCount | U(receiptNo), U(idempotencyKey); among SUCCESS payments **partial** U(transactionRef) for UPI + bank transfer together (one UTR space), U(ref, bankName, instrumentDate) for cheques, U(ref) for cards; cash ⇔ no reference; reference starts with a letter / digit; cheque ⇒ bank + date; canceller ≠ collector; cancelled ⇔ who / when / why (FC10–FC15). **Trigger:** only cancellation (once), print count (grows), version and actor SET NULL may change; never deleted |
| FeePaymentAllocation | paymentId, invoiceItemId, invoiceId, studentId, amount > 0, reversedAt? | PK(payment, item); composite FKs (item, invoice) → item, (payment, student) → payment, (invoice, student) → invoice, so a receipt can only pay its own student's invoices (review M2). **Trigger:** only reversedAt NULL → time; never deleted. Σ = payment (service + reconciliation report) |

Online payments (PENDING payments, gateway columns, PaymentGatewayEvent U(gateway, eventId)) are designed in PHASE_5_PLAN.md FC16 and come with Phase 6.

## 9. Transport

| Model | Key fields | Constraints |
|---|---|---|
| TransportVehicle (SD) | vehicleNo, model, capacity, insuranceNo/expiry, fitnessExpiry, permitNo/expiry, pucExpiry, status | U(vehicleNo) |
| VehicleDocument | vehicleId, type, fileId, expiresOn? | IX(expiresOn) |
| Driver (SD) | role (DRIVER/CONDUCTOR/ATTENDANT), employeeId?, name, phone, licenseNo?, licenseExpiry? | U(licenseNo) partial |
| TransportRoute | code, name, vehicleId?, driverId?, conductorId?, academicSessionId | U(session, code) |
| TransportStop | routeId, name, sequence, pickupTime, dropTime, lat?, lng?, monthlyFee | U(routeId, sequence) |
| StudentTransport | studentId, academicSessionId, routeId, stopId, startDate, endDate? | IX(routeId); partial U(studentId, session) where endDate null |
| VehicleMaintenance | vehicleId, date, type, description, cost, odometer, vendorId? | IX(vehicleId) |
| FuelRecord | vehicleId, date, litres Decimal(8,2), cost, odometer | IX(vehicleId, date) |

## 10. Examinations

**Phase 4B — migration `20261122000000_phase4b_examinations` (**applied** to development and Test 2026-11-20, owner-approved; drift exit 0 on both).** Design: PHASE_4_PLAN.md AC8–AC15. Offline diff + hand edits: one transaction, `lock_timeout`, 26 CHECKs. Expand-only; the only existing-table change is `school_setting.show_rank` (NOT NULL DEFAULT false — metadata-only). Every academic link carries the session in a composite FK.

| Model | Key fields | Constraints |
|---|---|---|
| GradeScale | name, nameKey, isActive, version | U(nameKey); name shape CHECKs (AC8 — school-defined; CBSE-style template offered, never created automatically) |
| GradeBand | scaleId, minPercent (0–100), grade, gradePoint? (0–10), remark? | U(scale, minPercent), U(scale, grade); bands are gap-free by construction (grade-calc.ts) |
| Examination | academicSessionId, name, nameKey, gradeScaleId, status (DRAFT/SCHEDULED/MARKS_ENTRY/LOCKED/PUBLISHED), startDate?, endDate?, publishedAt?, publishedById? | U(session, nameKey); U(id, session); dates in order; published fields iff PUBLISHED (AC9) |
| ExamSubject | examinationId + session, classSubjectId + session, examDate?, maxTheory / maxPractical / maxInternal (0–1000, sum > 0), passPercent? | U(exam, classSubject); U(id, session) |
| MarksSheet | examSubjectId + session, sectionId + session, status (OPEN/SUBMITTED/APPROVED), submitted / approved by + at | U(examSubject, section); submitted / approved fields iff status (AC13) |
| ExaminationMarks | marksSheetId + session, enrollmentId + session, status (PRESENT/ABSENT/EXEMPT), theory? / practical? / internal? (Decimal(5,1), whole or half marks), correctionReason?, enteredById? | U(sheet, enrollment); AB / EX carry no marks (AC10) |
| ReportCard | examinationId + session, enrollmentId + session, snapshot JSON, remark?, documentId? → GeneratedDocument, publishedAt | U(exam, enrollment); U(documentId); snapshot is an object (AC15) |
| SchoolSetting (+) | showRank (default false) | AC14 |

**Phase 4C — migration `20261123000000_phase4c_promotion_homework_calendar` (**applied** to development and Test 2026-11-20, owner-approved; drift exit 0 on both).** Design: PHASE_4_PLAN.md AC16–AC18. Offline diff + hand edits: one transaction, `lock_timeout`, 11 CHECKs. Expand-only: no existing table changes.

| Model | Key fields | Constraints |
|---|---|---|
| PromotionDecision | fromEnrollmentId + session, decision (PROMOTE/DETAIN/LEAVE), toClassId?, leaveAs? (TRANSFERRED/WITHDRAWN/GRADUATED), status (PROPOSED/CONFIRMED), proposed / confirmed by + at, toEnrollmentId?, version | U(fromEnrollment, session); U(toEnrollmentId); LEAVE ⇔ leaveAs and no class; confirmed fields iff CONFIRMED; next enrollment iff confirmed and not LEAVE (AC16) |
| Homework | sectionId + session, classSubjectId + session, title (≤150), details (≤4000), assignedOn, dueOn, postedById?, deletedAt? | due ≥ assigned; trimmed text (AC17; text only — KI-094) |
| AcademicEvent | academicSessionId, title (≤120), startDate, endDate, details? | dates in order (AC18) |

## 11. Library & inventory

| Model | Key fields | Constraints |
|---|---|---|
| LibraryBook (SD) | isbn?, title, authors, publisher, category, edition, totalCopies, availableCopies | IX(isbn), IX(title) |
| BookCopy | bookId, accessionNo, status (AVAILABLE/ISSUED/LOST/DAMAGED/WITHDRAWN) | U(accessionNo) |
| BookIssue | copyId, borrowerType (STUDENT/EMPLOYEE), studentId?, employeeId?, issuedAt, dueDate, returnedAt?, fineAmount, finePaid | IX(copyId); partial U(copyId) where returnedAt null |
| Location | name, building?, room? | U(name) |
| Vendor | name, contact, gstin? | U(name) |
| AssetCategory | name (Computers/Printers/Projectors/Furniture/Lab/Sports/Electrical/Other) | U(name) |
| InventoryItem (SD) | assetTag, categoryId, name, serialNo?, purchaseDate, purchaseAmount, vendorId?, warrantyUntil?, locationId?, assignedToEmployeeId?, status (IN_USE/IN_STORE/UNDER_REPAIR/DISPOSED), quantity (for consumables) | U(assetTag) |
| AssetMaintenance | itemId, date, description, cost, vendorId? | IX(itemId) |
| AssetDisposal | itemId (1:1), date, method, amountRecovered, approvedById | U(itemId) |

## 12. CMS (public website)

| Model | Key fields | Constraints |
|---|---|---|
| CMSPage | slug, title, seoDescription, status (DRAFT/PUBLISHED), publishedAt | U(slug) |
| CMSSection | pageId, type (HERO/RICH_TEXT/PRINCIPAL_MESSAGE/FACILITIES/STATS/GALLERY_STRIP/NOTICES/EVENTS/CONTACT/MAP/CTA…), order, isVisible, content JSON (validated by Zod per type), status | IX(pageId, order) |
| MenuItem | label, href or pageId, parentId?, order, isVisible | IX(parentId, order) |
| Banner | title, subtitle, imageFileId, link?, order, isActive | — |
| Notice (SD) | title, body (sanitized HTML), category, isImportant, attachmentFileId?, publishAt, expireAt?, status | IX(status, publishAt) |
| News (SD) | title, slug, excerpt, body, coverFileId, publishAt, status | U(slug) |
| Event (SD) | title, slug, description, startAt, endAt, venue, coverFileId?, status | U(slug), IX(startAt) |
| GalleryAlbum / GalleryImage | album: title, slug, order, status · image: albumId, fileId, caption, order | U(album.slug) |
| Download | title, category (ADMISSION_FORM/SYLLABUS/CIRCULAR/OTHER), fileId, status | — |
| AdmissionEnquiry | studentName, desiredClass, parentName, phone, email?, message, status (NEW/CONTACTED/CONVERTED/CLOSED), ipHash | IX(status, createdAt) |

## 13. Chatbot

| Model | Key fields | Constraints |
|---|---|---|
| ChatbotConfig | singleton: systemInstructions, provider, model, temperature, maxTokens, fallbackMessage, isEnabled (API keys are **env only**) | — |
| ChatbotKnowledge | title, sourceType (MANUAL/PDF/DOCX/CMS_SYNC), category, body (extracted text), fileId?, isActive, status (DRAFT/PUBLISHED), version | IX(isActive, status) |
| KnowledgeChunk | knowledgeId, chunkIndex, content, tokenCount, embedding vector(N)?, tsv tsvector (generated) | U(knowledgeId, chunkIndex); HNSW index on embedding; GIN on tsv |
| ChatbotFAQ | question, answer, category, isActive, order | — |
| ChatConversation | visitorId (random cookie, not PII), startedAt, messageCount, ipHash | IX(startedAt) |
| ChatMessage | conversationId, role, content, retrievedChunkIds, answered (bool: grounded vs fallback), latencyMs, feedback? | IX(conversationId) |

## 14. Notifications, imports, audit

| Model | Key fields | Constraints |
|---|---|---|
| Notification | userId, type, title, body, link?, readAt?, channel (IN_APP/EMAIL/SMS), dedupeKey? (Phase 6A) | IX(userId, readAt), IX(userId, createdAt DESC); partial U(userId, dedupeKey) WHERE dedupe_key IS NOT NULL (Phase 6A — idempotent fan-out, e.g. one absence alert per child per day) |
| NotificationPreference | userId, type, inApp, email, sms | PK(userId, type) |
| ImportJob | module, fileId, mapping JSON, status (UPLOADED/MAPPED/VALIDATED/IMPORTING/COMPLETED/FAILED/CANCELLED), totals, reportFileId?, createdById | IX(createdById) |
| ImportRow | jobId, rowNumber, data JSON, errors JSON, status (VALID/INVALID/DUPLICATE/IMPORTED/SKIPPED), entityId? | U(jobId, rowNumber) |
| AuditLog | actorId?, actorRole, action (e.g. `student.update`), entityType, entityId, before JSON?, after JSON?, ip, userAgent, requestId, at | IX(entityType, entityId), IX(actorId, at), IX(action, at). Append-only (no UPDATE/DELETE grants for the app DB role in prod). |

## 15. Name-to-spec mapping

Spec model → planned model: `StudentClass` → SchoolClass (+StudentEnrollment) · `Attendance` → StudentAttendance + EmployeeAttendance · `Timetable` → TimetableSlot · `Inventory` → InventoryItem · `Gallery` → GalleryAlbum/GalleryImage · `Teacher` → Employee + TeacherProfile (one person table for all staff avoids duplicated HR/payroll logic).

## Phase 6A additions (migration `20261126000000_phase6a_portal_accounts` — owner-approved, applied to development and Test 2026-11-22)

- `student_guardian.portal_access boolean NOT NULL DEFAULT true` — P24 custody block (a guardian's portal account can't see this student).
- `fee_invoice_item` (KI-105, P15): `waived_amount numeric(12,2)?`, `waiver_reason varchar(500)?`, `waived_by_id → user (SET NULL)?`, `waived_with_payment_id → fee_payment (RESTRICT)?`, `frozen_by_payment_id → fee_payment (RESTRICT)?`; IX on both payment links; CHECK `fee_invoice_item_waiver` (waiver data only on a zero LATE_FEE line, then amount > 0 and a reason), CHECK `fee_invoice_item_frozen_kind` (a freezing payment only on LATE_FEE lines). Backfill: existing waiver lines move amount and reason out of `description` ("Late fee waived").
- `user` / `account_activation` / `notification` changes as in §1 and §14. Backup / restore order: `user.student_id` and `user.guardian_id` are deferred columns (scripts/db-tables.ts); `fee_payment` now precedes `fee_invoice_item`.
