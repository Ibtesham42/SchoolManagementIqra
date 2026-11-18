# Phase 3A — M1: final Prisma schema proposal and migration SQL (for review)

**Status: SQL APPROVED by the owner 2026-11-18 (after the 2026-11-11 amendments: lock timeout, guarded rollback, Unicode-safe department/designation names). §12 step 1 DONE 2026-11-18 — migration folder `prisma/migrations/20261112000000_phase3a_hr_core/` (migration.sql = §4 with only the review-status and rollback-path comments updated; ROLLBACK.sql.txt = §5), `prisma/schema.prisma` updated, guard test added. **Step 2 DONE 2026-11-18: applied to DEVELOPMENT** (08:19:52–08:19:58Z; restore point 08:19:43Z; drift exit 0; `db:check` ✓; checksum `59fc40ff981d9a85`). **Step 3 DONE 2026-11-18: applied to TEST** (08:22:54–08:23:00Z; restore point 08:22:45Z; drift exit 0; `db:check` ✓; same checksum). Production never without explicit approval (Phase 10).**
Decisions: PHASE_3_PLAN.md §3a (H1–H14, Q1–Q3), ADR-036. Phase 2B closure (M0) remains a separate, required gate.

## 1. How this was produced (offline)

1. Copied `prisma/schema.prisma` (current) and wrote a proposed copy with the Phase 3A models (session scratchpad, not the repository).
2. `prisma validate` on the proposed schema — **valid**.
3. `prisma migrate diff --from-schema <current> --to-schema <proposed> --script` — compares two schema **files** (no database, no shadow database). The Prisma CLI's `.env` loading was pointed at a non-existent file and `DIRECT_URL` at a placeholder on a closed local port: no secret read, no connection possible. (Same method as migrations `20261110000000` and `20261111000000`.)
4. Hand-edited: one transaction, `lock_timeout`, a read-only pre-check, 21 CHECK constraints, comments. A script confirmed that **all 37 generated statements are present unchanged**, and that the file contains **no invisible characters** (control and zero-width characters appear only as `\uXXXX` escapes inside the regular expressions).

Proposed migration name: **`20261112000000_phase3a_hr_core`**.

## 2. Changes to existing models (schema only)

| Model | Change | SQL effect |
|---|---|---|
| `User` | `employee Employee? @relation("UserEmployee", fields: [employeeId], references: [id], onDelete: Restrict)` on the **existing** `employeeId` column; back-relations `employeesCreated`, `employeeDocsUploaded`, `employeeDocsVerified`, `serviceEventsActed`; comment updated | **One FK** `user_employee_id_fkey` (the existing unique index `user_employee_id_key` is reused; no column change) |
| `StoredFile` | back-relation `employeeDocument EmployeeDocument? @relation("EmployeeDocumentFile")` | none |
| `Gender` enum (Phase 2B) | reused by `Employee.gender` | none |

## 3. New models (Prisma)

```prisma
// ───────────────────────────── Phase 3A — HR core (ADR-036; PHASE_3_PLAN.md §3a) ─────────────────────────────
// One school per installation (ADR-030): no school_id. People and history are never hard-deleted: every FK
// RESTRICT except actor references (SET NULL). CHECK constraints are hand-written in the migration.

enum StaffType {
  TEACHING
  NON_TEACHING
}

enum AppointmentType {
  PERMANENT
  PROBATION
  CONTRACT
  PART_TIME
  GUEST
}

enum EmploymentStatus {
  ACTIVE
  ON_LEAVE
  RESIGNED
  TERMINATED
  RETIRED
}

enum EmployeeDocumentType {
  PHOTO
  RESUME
  QUALIFICATION_CERTIFICATE
  EXPERIENCE_LETTER
  APPOINTMENT_LETTER
  RELIEVING_LETTER
  OTHER
}

enum ServiceEventType {
  JOINED
  CONFIRMED
  DEPARTMENT_CHANGED
  DESIGNATION_CHANGED
  APPOINTMENT_TYPE_CHANGED
  REPORTING_CHANGED
  TRANSFERRED
  STATUS_CHANGED
  RESIGNED
  TERMINATED
  RETIRED
  REJOINED
}

/// Master data (H9): deactivated, never deleted once used. Case-insensitive unique name via nameKey.
model Department {
  id        String   @id @default(cuid(2))
  code      String   @unique @db.VarChar(20)
  name      String   @db.VarChar(80)
  nameKey   String   @unique @map("name_key") @db.VarChar(80)
  isActive  Boolean  @default(true) @map("is_active")
  version   Int      @default(1)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  employees Employee[]

  @@map("department")
}

/// Master data (H9). An employee's staffType must equal the designation's (service rule).
model Designation {
  id        String    @id @default(cuid(2))
  code      String    @unique @db.VarChar(20)
  name      String    @db.VarChar(80)
  nameKey   String    @unique @map("name_key") @db.VarChar(80)
  staffType StaffType @map("staff_type")
  isActive  Boolean   @default(true) @map("is_active")
  version   Int       @default(1)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  employees Employee[]

  @@map("designation")
}

/// One record per staff member (teaching and non-teaching), separate from login credentials (H2).
/// employeeCode is permanent (H3). No Aadhaar/PAN/bank/medical data in Phase 3A (H5). Soft delete only.
model Employee {
  id                 String           @id @default(cuid(2))
  /// Permanent employee ID, e.g. "EMP-2026-0001" (SchoolSetting.idFormats.employeeCode; {YYYY} = joining year).
  employeeCode       String           @unique @map("employee_code") @db.VarChar(32)
  staffType          StaffType        @map("staff_type")
  appointmentType    AppointmentType  @map("appointment_type")
  employmentStatus   EmploymentStatus @default(ACTIVE) @map("employment_status")
  firstName          String           @map("first_name") @db.VarChar(60)
  middleName         String?          @map("middle_name") @db.VarChar(60)
  lastName           String?          @map("last_name") @db.VarChar(60)
  fullName           String           @map("full_name") @db.VarChar(185)
  fullNameNormalized String           @map("full_name_normalized") @db.VarChar(185)
  dob                DateTime         @db.Date
  gender             Gender
  workPhone          String?          @map("work_phone") @db.VarChar(10)
  personalPhone      String           @map("personal_phone") @db.VarChar(10)
  workEmail          String?          @map("work_email") @db.VarChar(254)
  personalEmail      String?          @map("personal_email") @db.VarChar(254)
  /// { line1, line2?, city, district?, state, pinCode, country } — personal tier (H6).
  address            Json?
  /// { name, relation, phone } — personal tier (H6).
  emergencyContact   Json?            @map("emergency_contact")
  departmentId       String           @map("department_id")
  designationId      String           @map("designation_id")
  reportsToId        String?          @map("reports_to_id")
  joiningDate        DateTime         @map("joining_date") @db.Date
  confirmationDate   DateTime?        @map("confirmation_date") @db.Date
  leavingDate        DateTime?        @map("leaving_date") @db.Date
  leavingReason      String?          @map("leaving_reason") @db.VarChar(500)
  version            Int              @default(1)
  createdById        String?          @map("created_by_id")
  createdAt          DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt          DateTime         @updatedAt @map("updated_at") @db.Timestamptz(3)
  deletedAt          DateTime?        @map("deleted_at") @db.Timestamptz(3)

  department     Department             @relation(fields: [departmentId], references: [id], onDelete: Restrict)
  designation    Designation            @relation(fields: [designationId], references: [id], onDelete: Restrict)
  /// Reporting line (H10): self-reference; no self-reporting (CHECK) and no cycles (service, under locks).
  reportsTo      Employee?              @relation("EmployeeReportsTo", fields: [reportsToId], references: [id], onDelete: Restrict)
  directReports  Employee[]             @relation("EmployeeReportsTo")
  createdBy      User?                  @relation("EmployeeCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  /// Optional login account (H2): the FK lives on User.employeeId.
  user           User?                  @relation("UserEmployee")
  teacherProfile TeacherProfile?
  documents      EmployeeDocument[]
  serviceEvents  EmployeeServiceEvent[]

  @@index([fullNameNormalized])
  @@index([staffType, employmentStatus])
  @@index([departmentId])
  @@index([designationId])
  @@index([reportsToId])
  @@map("employee")
}

/// 1:1 with a TEACHING employee (service rule). Specialisations are free text until Phase 4 subjects (H14).
model TeacherProfile {
  employeeId                String   @id @map("employee_id")
  /// [{ degree, subject?, institution?, year? }] — at most 10 (schema + CHECK).
  qualifications            Json     @default("[]")
  /// [{ name (e.g. B.Ed, CTET), year? }] — at most 10.
  professionalQualifications Json    @default("[]") @map("professional_qualifications")
  specializations           String[] @default([]) @db.VarChar(60)
  experienceYearsBefore     Int      @default(0) @map("experience_years_before") @db.SmallInt
  teacherRegistrationNo     String?  @map("teacher_registration_no") @db.VarChar(40)
  version                   Int      @default(1)
  createdAt                 DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt                 DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  employee Employee @relation(fields: [employeeId], references: [id], onDelete: Restrict)

  @@map("teacher_profile")
}

/// A staff document; its StoredFile (PRIVATE, encrypted) is owned by this row (ownerType "EmployeeDocument").
model EmployeeDocument {
  id           String               @id @default(cuid(2))
  employeeId   String               @map("employee_id")
  type         EmployeeDocumentType
  fileId       String               @unique @map("file_id")
  /// Optional free text, required for OTHER.
  label        String?              @db.VarChar(80)
  uploadedById String?              @map("uploaded_by_id")
  verifiedById String?              @map("verified_by_id")
  verifiedAt   DateTime?            @map("verified_at") @db.Timestamptz(3)
  createdAt    DateTime             @default(now()) @map("created_at") @db.Timestamptz(3)
  /// Replaced or removed (its StoredFile is retired in the same transaction).
  deletedAt    DateTime?            @map("deleted_at") @db.Timestamptz(3)

  employee   Employee   @relation(fields: [employeeId], references: [id], onDelete: Restrict)
  file       StoredFile @relation("EmployeeDocumentFile", fields: [fileId], references: [id], onDelete: Restrict)
  uploadedBy User?      @relation("EmployeeDocumentUploadedBy", fields: [uploadedById], references: [id], onDelete: SetNull)
  verifiedBy User?      @relation("EmployeeDocumentVerifiedBy", fields: [verifiedById], references: [id], onDelete: SetNull)

  /// One current photo per employee.
  @@unique([employeeId], map: "employee_document_employee_photo_key", where: raw("type = 'PHOTO' AND deleted_at IS NULL"))
  @@index([employeeId])
  @@map("employee_document")
}

/// Append-only career history (H12): written by the service in the same transaction as the change;
/// no update/delete path. (A DB trigger is a separate S-07 decision.)
model EmployeeServiceEvent {
  id            String           @id @default(cuid(2))
  employeeId    String           @map("employee_id")
  eventType     ServiceEventType @map("event_type")
  effectiveDate DateTime         @map("effective_date") @db.Date
  /// Changed fields only (ids / codes / enum values — never personal-tier values).
  before        Json?
  after         Json?
  remarks       String?          @db.VarChar(500)
  actedById     String?          @map("acted_by_id")
  createdAt     DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)

  employee Employee @relation(fields: [employeeId], references: [id], onDelete: Restrict)
  actedBy  User?    @relation("EmployeeServiceEventActedBy", fields: [actedById], references: [id], onDelete: SetNull)

  @@index([employeeId, effectiveDate])
  @@map("employee_service_event")
}
```

## 4. Forward migration SQL (complete, amended)

```sql
-- Phase 3A: HR core — departments, designations, employees, teacher profiles, employee documents,
-- append-only service history, and the FK on user.employee_id (ADR-036; PHASE_3_PLAN.md §3a).
-- Generated offline by `prisma migrate diff --from-schema <current schema> --to-schema <proposed schema>
-- --script` (no database touched; `.env` loading disabled), then hand-edited:
--   * wrapped in one transaction;
--   * a read-only pre-check refuses to run if user.employee_id already holds values;
--   * CHECK constraints added (Prisma does not model them), validated immediately (all tables new and empty);
--   * the partial unique index (one current photo per employee) is schema-expressed (previewFeatures =
--     ["partialIndexes"], ADR-034), so later `migrate diff` / drift checks keep it;
--   * lock_timeout 5 s, so the migration fails cleanly instead of queueing sign-ins behind a blocked lock;
--   * department/designation names accept any script (Hindi, Khasi, …): the database checks Unicode
--     normalization and shape; the application builds the case-insensitive name_key (NFKC + Unicode lower case).
-- Expand-only: 5 enums and 6 new tables; the only change to an EXISTING table is one new foreign key on
-- "user"."employee_id" (a nullable column with no values on development/Test). Nothing is dropped, renamed or
-- rewritten, so the previous release keeps working. Single-school installation (ADR-030): no school_id.
-- Review status: DRAFT — AWAITING OWNER APPROVAL — do not apply.
--
-- Rollback: use ONLY the guarded rollback script (PHASE_3A_M1_SCHEMA_PROPOSAL.md §5) — it refuses to drop anything
-- while any HR row or linked account exists (then restore from the Neon restore point instead).
-- and revert prisma/schema.prisma in the same change. Never edit this file after it has been applied.

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';

-- ─── 0. Pre-check (read-only): the existing user.employee_id column must be empty ─────────────────
-- It was reserved in Phase 1 and never written. If any value exists, the FK below could fail or link
-- accounts to records that don't exist yet — stop and review instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user" WHERE "employee_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'Phase 3A migration refused: "user"."employee_id" already holds values. Nothing was changed.';
  END IF;
END $$;

-- ─── 1. Enums ───────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "StaffType" AS ENUM ('TEACHING', 'NON_TEACHING');
CREATE TYPE "AppointmentType" AS ENUM ('PERMANENT', 'PROBATION', 'CONTRACT', 'PART_TIME', 'GUEST');
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'RESIGNED', 'TERMINATED', 'RETIRED');
CREATE TYPE "EmployeeDocumentType" AS ENUM ('PHOTO', 'RESUME', 'QUALIFICATION_CERTIFICATE', 'EXPERIENCE_LETTER', 'APPOINTMENT_LETTER', 'RELIEVING_LETTER', 'OTHER');
CREATE TYPE "ServiceEventType" AS ENUM ('JOINED', 'CONFIRMED', 'DEPARTMENT_CHANGED', 'DESIGNATION_CHANGED', 'APPOINTMENT_TYPE_CHANGED', 'REPORTING_CHANGED', 'TRANSFERRED', 'STATUS_CHANGED', 'RESIGNED', 'TERMINATED', 'RETIRED', 'REJOINED');

-- ─── 2. Master data (H9: deactivated, never deleted once used) ─────────────────────────────────
CREATE TABLE "department" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "designation" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "staff_type" "StaffType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "designation_pkey" PRIMARY KEY ("id")
);

-- ─── 3. Employee (one record per staff member; separate from login credentials, H2) ────────────
CREATE TABLE "employee" (
    "id" TEXT NOT NULL,
    "employee_code" VARCHAR(32) NOT NULL,
    "staff_type" "StaffType" NOT NULL,
    "appointment_type" "AppointmentType" NOT NULL,
    "employment_status" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "first_name" VARCHAR(60) NOT NULL,
    "middle_name" VARCHAR(60),
    "last_name" VARCHAR(60),
    "full_name" VARCHAR(185) NOT NULL,
    "full_name_normalized" VARCHAR(185) NOT NULL,
    "dob" DATE NOT NULL,
    "gender" "Gender" NOT NULL,
    "work_phone" VARCHAR(10),
    "personal_phone" VARCHAR(10) NOT NULL,
    "work_email" VARCHAR(254),
    "personal_email" VARCHAR(254),
    "address" JSONB,
    "emergency_contact" JSONB,
    "department_id" TEXT NOT NULL,
    "designation_id" TEXT NOT NULL,
    "reports_to_id" TEXT,
    "joining_date" DATE NOT NULL,
    "confirmation_date" DATE,
    "leaving_date" DATE,
    "leaving_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "employee_pkey" PRIMARY KEY ("id")
);

-- ─── 4. Teacher profile (1:1 with a TEACHING employee — service rule) ──────────────────────────
CREATE TABLE "teacher_profile" (
    "employee_id" TEXT NOT NULL,
    "qualifications" JSONB NOT NULL DEFAULT '[]',
    "professional_qualifications" JSONB NOT NULL DEFAULT '[]',
    "specializations" VARCHAR(60)[] DEFAULT ARRAY[]::VARCHAR(60)[],
    "experience_years_before" SMALLINT NOT NULL DEFAULT 0,
    "teacher_registration_no" VARCHAR(40),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teacher_profile_pkey" PRIMARY KEY ("employee_id")
);

-- ─── 5. Employee documents (private, encrypted StoredFile owned by the row; H8) ─────────────────
CREATE TABLE "employee_document" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "type" "EmployeeDocumentType" NOT NULL,
    "file_id" TEXT NOT NULL,
    "label" VARCHAR(80),
    "uploaded_by_id" TEXT,
    "verified_by_id" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "employee_document_pkey" PRIMARY KEY ("id")
);

-- ─── 6. Service history (append-only at application level, H12; no trigger — S-07 decision) ────
CREATE TABLE "employee_service_event" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "event_type" "ServiceEventType" NOT NULL,
    "effective_date" DATE NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "remarks" VARCHAR(500),
    "acted_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_service_event_pkey" PRIMARY KEY ("id")
);

-- ─── 7. Indexes and unique constraints ──────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "department_code_key" ON "department"("code");
CREATE UNIQUE INDEX "department_name_key_key" ON "department"("name_key");
CREATE UNIQUE INDEX "designation_code_key" ON "designation"("code");
CREATE UNIQUE INDEX "designation_name_key_key" ON "designation"("name_key");
CREATE UNIQUE INDEX "employee_employee_code_key" ON "employee"("employee_code");
CREATE INDEX "employee_full_name_normalized_idx" ON "employee"("full_name_normalized");
CREATE INDEX "employee_staff_type_employment_status_idx" ON "employee"("staff_type", "employment_status");
CREATE INDEX "employee_department_id_idx" ON "employee"("department_id");
CREATE INDEX "employee_designation_id_idx" ON "employee"("designation_id");
CREATE INDEX "employee_reports_to_id_idx" ON "employee"("reports_to_id");
CREATE UNIQUE INDEX "employee_document_file_id_key" ON "employee_document"("file_id");
CREATE INDEX "employee_document_employee_id_idx" ON "employee_document"("employee_id");
-- One current photo per employee (schema-expressed partial index).
CREATE UNIQUE INDEX "employee_document_employee_photo_key" ON "employee_document"("employee_id") WHERE (type = 'PHOTO' AND deleted_at IS NULL);
CREATE INDEX "employee_service_event_employee_id_effective_date_idx" ON "employee_service_event"("employee_id", "effective_date");

-- ─── 8. Foreign keys (people and history: RESTRICT; actor references: SET NULL) ─────────────────
-- The only change to an EXISTING table: user.employee_id (unique, nullable, empty — see pre-check) → employee.
ALTER TABLE "user" ADD CONSTRAINT "user_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee" ADD CONSTRAINT "employee_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee" ADD CONSTRAINT "employee_designation_id_fkey" FOREIGN KEY ("designation_id") REFERENCES "designation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee" ADD CONSTRAINT "employee_reports_to_id_fkey" FOREIGN KEY ("reports_to_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee" ADD CONSTRAINT "employee_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "teacher_profile" ADD CONSTRAINT "teacher_profile_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "employee_service_event" ADD CONSTRAINT "employee_service_event_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_service_event" ADD CONSTRAINT "employee_service_event_acted_by_id_fkey" FOREIGN KEY ("acted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 9. CHECK constraints (hand-written; Prisma does not model them). New, empty tables → validated now.
-- Master data names (amended 2026-11-11): any script is allowed (Hindi, Khasi, other Indian languages).
-- The database checks SHAPE only, independent of the database collation: `name` keeps the original spelling,
-- NFC-normalized, trimmed, single spaces, no control or zero-width-space characters; `name_key` is the
-- application-built case-insensitive key (NFKC → Unicode lower case → NFKC, same shape rules) and is UNIQUE.
-- Allowed characters (letters/marks of any script, digits, space and . , & ( ) / ' -) are enforced by the
-- application; Postgres regex classes depend on the locale and can't express them reliably.
ALTER TABLE "department" ADD CONSTRAINT "department_code_format_check" CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$');
ALTER TABLE "department" ADD CONSTRAINT "department_name_shape_check"
  CHECK ("name" IS NFC NORMALIZED AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> ''
     AND "name" !~ '[\u0001-\u001F\u007F\u200B\uFEFF]');
ALTER TABLE "department" ADD CONSTRAINT "department_name_key_shape_check"
  CHECK ("name_key" IS NFKC NORMALIZED AND "name_key" = regexp_replace(btrim("name_key"), '\s+', ' ', 'g') AND "name_key" <> ''
     AND "name_key" !~ '[\u0001-\u001F\u007F\u200B\uFEFF]');
ALTER TABLE "department" ADD CONSTRAINT "department_version_check" CHECK ("version" >= 1);
ALTER TABLE "designation" ADD CONSTRAINT "designation_code_format_check" CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$');
ALTER TABLE "designation" ADD CONSTRAINT "designation_name_shape_check"
  CHECK ("name" IS NFC NORMALIZED AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> ''
     AND "name" !~ '[\u0001-\u001F\u007F\u200B\uFEFF]');
ALTER TABLE "designation" ADD CONSTRAINT "designation_name_key_shape_check"
  CHECK ("name_key" IS NFKC NORMALIZED AND "name_key" = regexp_replace(btrim("name_key"), '\s+', ' ', 'g') AND "name_key" <> ''
     AND "name_key" !~ '[\u0001-\u001F\u007F\u200B\uFEFF]');
ALTER TABLE "designation" ADD CONSTRAINT "designation_version_check" CHECK ("version" >= 1);

-- Employee
ALTER TABLE "employee" ADD CONSTRAINT "employee_version_check" CHECK ("version" >= 1);
ALTER TABLE "employee" ADD CONSTRAINT "employee_code_check" CHECK (btrim("employee_code") <> '');
ALTER TABLE "employee" ADD CONSTRAINT "employee_name_check"
  CHECK ("full_name_normalized" = btrim("full_name_normalized") AND "full_name_normalized" <> '' AND "first_name" <> '');
ALTER TABLE "employee" ADD CONSTRAINT "employee_phone_check"
  CHECK ("personal_phone" ~ '^[0-9]{10}$' AND ("work_phone" IS NULL OR "work_phone" ~ '^[0-9]{10}$'));
-- Adults born 1940 or later, before they joined.
ALTER TABLE "employee" ADD CONSTRAINT "employee_dob_check" CHECK ("dob" >= DATE '1940-01-01' AND "dob" < "joining_date");
ALTER TABLE "employee" ADD CONSTRAINT "employee_dates_check"
  CHECK (("confirmation_date" IS NULL OR "confirmation_date" >= "joining_date")
     AND ("leaving_date" IS NULL OR "leaving_date" >= "joining_date"));
-- H11: a leaving status ⇔ a leaving date and a reason; active/on-leave staff have neither.
ALTER TABLE "employee" ADD CONSTRAINT "employee_leaving_check"
  CHECK (("employment_status" IN ('RESIGNED', 'TERMINATED', 'RETIRED')) = ("leaving_date" IS NOT NULL)
     AND ("leaving_date" IS NULL) = ("leaving_reason" IS NULL));
-- H10: nobody reports to themselves (cycles are prevented by the service under row locks).
ALTER TABLE "employee" ADD CONSTRAINT "employee_reports_to_check" CHECK ("reports_to_id" IS NULL OR "reports_to_id" <> "id");

-- Teacher profile (H14: at most 10 specialisations of ≤ 60 characters — the column type caps the length)
ALTER TABLE "teacher_profile" ADD CONSTRAINT "teacher_profile_version_check" CHECK ("version" >= 1);
ALTER TABLE "teacher_profile" ADD CONSTRAINT "teacher_profile_experience_check" CHECK ("experience_years_before" BETWEEN 0 AND 60);
ALTER TABLE "teacher_profile" ADD CONSTRAINT "teacher_profile_specializations_check"
  CHECK ("specializations" IS NOT NULL AND cardinality("specializations") <= 10);
ALTER TABLE "teacher_profile" ADD CONSTRAINT "teacher_profile_qualifications_check"
  CHECK (jsonb_typeof("qualifications") = 'array' AND jsonb_array_length("qualifications") <= 10
     AND jsonb_typeof("professional_qualifications") = 'array' AND jsonb_array_length("professional_qualifications") <= 10);

-- Documents: OTHER needs a description.
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_label_check" CHECK ("type" <> 'OTHER' OR "label" IS NOT NULL);

COMMIT;
```

## 5. Rollback SQL (guarded; replaces the earlier unguarded comment block)

```sql
-- Phase 3A (20261112000000_phase3a_hr_core) - GUARDED ROLLBACK. Manual, owner-approved use only; never run
-- by a deploy (Prisma has no down migrations). Development/Test only, never production.
-- Refuses (and changes nothing) unless every HR table is empty and no account is linked to an employee.
-- No CASCADE: a DROP fails rather than reaching anything outside the six HR tables. stored_file rows and the
-- encrypted files they describe are NOT touched. Once real HR data exists, restore the branch from the Neon
-- restore point taken before applying instead (a separate, approved operation).
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "employee") + (SELECT count(*) FROM "department") + (SELECT count(*) FROM "designation")
       + (SELECT count(*) FROM "teacher_profile") + (SELECT count(*) FROM "employee_document")
       + (SELECT count(*) FROM "employee_service_event") + (SELECT count(*) FROM "user" WHERE "employee_id" IS NOT NULL)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 3A rollback refused: % HR row(s) or linked account(s) exist. Restore from the Neon restore point instead. Nothing was changed.', n;
  END IF;
END $$;

ALTER TABLE "user" DROP CONSTRAINT "user_employee_id_fkey";
DROP TABLE "employee_service_event";
DROP TABLE "employee_document";
DROP TABLE "teacher_profile";
DROP TABLE "employee";
DROP TABLE "designation";
DROP TABLE "department";
DROP TYPE "ServiceEventType", "EmployeeDocumentType", "EmploymentStatus", "AppointmentType", "StaffType";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112000000_phase3a_hr_core';
COMMIT;
-- Afterwards: revert prisma/schema.prisma and remove the migration folder in the same change.
```
**Cannot delete real employee data by accident:** it refuses (and changes nothing) while any HR row or linked account exists; it has no `CASCADE`; it never touches `stored_file` rows or encrypted files; Prisma has no down migrations, so no deploy can run it. With real data, the only reversal is a Neon point-in-time restore from the restore point taken before applying (separate approval; it rewinds the whole branch to that moment).

## 6. Pre-check for `User.employeeId`

Inside the migration (section 0, same transaction):
```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user" WHERE "employee_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'Phase 3A migration refused: "user"."employee_id" already holds values. Nothing was changed.';
  END IF;
END $$;
```
Stand-alone read-only check, run (with approval) before applying and reported:
```sql
BEGIN READ ONLY;
SELECT count(*) AS linked_accounts FROM "user" WHERE "employee_id" IS NOT NULL;   -- expected 0
ROLLBACK;
```

## 7. Transaction safety, foreign-key validation and locking

- **Atomic schema change:** every statement is transactional in PostgreSQL (`CREATE TYPE … AS ENUM`, `CREATE TABLE`, non-concurrent `CREATE INDEX`, `ALTER TABLE … ADD CONSTRAINT`, `DO`, `SET LOCAL`); none of the non-transactional statements (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`, `VACUUM`) is used. Any failure → the whole file rolls back; no enum, table, index or constraint remains.
- **What can remain after a failure:** Prisma's own `_prisma_migrations` row (written outside our transaction) is left marked *failed*; further deploys are refused until `prisma migrate resolve --rolled-back 20261112000000_phase3a_hr_core` (bookkeeping only). The static guard test will assert `BEGIN`/`COMMIT` are present and no non-transactional statement appears.
- **FK on `"user"`:** `ADD CONSTRAINT … FOREIGN KEY` takes `SHARE ROW EXCLUSIVE` on `"user"` and `"employee"` until `COMMIT`: reads continue, writes to `user` (sign-in timestamps, user edits, lockout updates) wait. Validation scans `user` rows and finds `employee_id IS NULL` everywhere — milliseconds for one school. The other new FKs take the same brief lock on `stored_file` (uploads wait) and `user`; the rest reference new tables.
- **Lock queueing:** `SET LOCAL lock_timeout = '5s'` makes the migration fail cleanly (nothing changed) instead of waiting behind a long transaction while every later sign-in queues behind it. `NOT VALID` + `VALIDATE` isn't needed (nothing to validate).

## 8. Partial unique photo index vs Phase 2B

```sql
-- Phase 3A (proposed)
CREATE UNIQUE INDEX "employee_document_employee_photo_key" ON "employee_document"("employee_id")
  WHERE (type = 'PHOTO' AND deleted_at IS NULL);
-- Phase 2B (applied to development and Test)
CREATE UNIQUE INDEX "student_document_application_photo_key" ON "student_document"("application_id")
  WHERE (type = 'PHOTO' AND deleted_at IS NULL AND application_id IS NOT NULL);
CREATE UNIQUE INDEX "student_document_student_photo_key" ON "student_document"("student_id")
  WHERE (type = 'PHOTO' AND deleted_at IS NULL AND student_id IS NOT NULL);
```
Same pattern (one current photo per owner; retired photos unlimited; schema-expressed). The extra `IS NOT NULL` in Phase 2B exists because a student document has two optional owners; `employee_id` is `NOT NULL`. The Phase 2B predicates showed no drift after applying (unlike KI-055's `IN (…)` form); the drift check after applying confirms.

## 9. Department and designation names — Unicode-safe uniqueness (amended)

**Supported:** Hindi and other Devanagari, Bengali/Assamese, Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi, Odia, Khasi (Latin with ï/ñ), English — any script.

**Application rules (shared helper in M2, unit-tested; the service is the only writer):**
1. `name` (original spelling): Unicode **NFC**; trim; collapse every run of Unicode whitespace (incl. no-break space) to one space; remove zero-width space (U+200B) and BOM (U+FEFF); keep ZWJ/ZWNJ (U+200D/U+200C) only between letters (they shape Indic conjuncts); allowed: letters and combining marks of any script (`\p{L}\p{M}`), digits (`\p{Nd}`), space and `. , & ( ) / ' -`; must start with a letter or digit; 1–80 characters.
2. `name_key` (uniqueness): `NFKC(name)` → locale-independent Unicode lower case (`toLowerCase()`, never locale-specific, so no Turkish-i surprises) → `NFKC` again → same whitespace rule. Effects: composed and decomposed spellings collide (क़ as one code point or क + nukta; Khasi ï as one code point or i + diaeresis); `Ïing` and `ïing` collide; full-width Latin folds to normal width; Devanagari has no case, so only normalization applies.
3. Search matches on `name_key`; display sorting uses `Intl.Collator('en-IN')` in the application (independent of the database collation), as roll numbers do.

**Database (shape only — no dependency on `lower()` or the database collation):** `name IS NFC NORMALIZED`, `name_key IS NFKC NORMALIZED`, both trimmed with single spaces and non-empty, neither containing control characters, U+200B or U+FEFF; **UNIQUE(`name_key`)**. The earlier `name ~ '^[ -~]+$'` and `name_key = lower(name)` checks were removed (they were correct only for ASCII). `code` stays ASCII `^[A-Z0-9]+(-[A-Z0-9]+)*$` (identifier).

**Tests (M2):** Hindi composed vs decomposed → one key; Khasi Ï/ï → one key; Latin vs Devanagari never collide; U+200B removed; emoji and control characters refused; names differing only by ZWJ/ZWNJ — **owner choice** (proposal: treated as distinct, since the joiner changes the rendered spelling).

**Related, optional (decide at M2):** employee personal names already accept any script; their search key is NFC + lower case (Phase 2B convention). Aligning it to the same NFKC rule would also fold compatibility forms; it changes no stored data in 3A (no employees exist yet).

## 10. Destructive or potentially risky operations

**Forward migration: no DROP, DELETE, TRUNCATE, RENAME, ALTER COLUMN, type change or data rewrite.** The only "DELETE" text is `ON DELETE RESTRICT/SET NULL` in FK clauses. Every statement except one creates something new.

| # | Statement | Risk | Why it is safe / mitigation |
|---|---|---|---|
| 1 | `ALTER TABLE "user" ADD CONSTRAINT "user_employee_id_fkey" …` — the **only change to an existing table** | Fails if `user.employee_id` holds a non-employee value; brief write lock on `user` | Column never written by any code (grep: no use); in-migration pre-check aborts with "Nothing was changed"; 5 s lock timeout; milliseconds of validation; apply outside school hours on shared branches |
| 2 | `ON DELETE RESTRICT` on `user.employee_id` | Deleting a linked Employee fails | Intended: soft delete only; unlinking is explicit and audited |
| 3 | `ON DELETE RESTRICT` employee → department / designation / reports-to / teacher profile / documents / events | Hard deletes of used master data or people fail | Intended (H9, H12): deactivate / soft-delete |
| 4 | `ON DELETE SET NULL` on actor columns | Deleting a user blanks actor references | Phase 2B convention; users are deactivated, the audit log keeps the actor label |
| 5 | `employee_document_file_id_fkey` → `stored_file` RESTRICT | A referenced stored file can't be deleted | Intended; the S-15 lifecycle (pending decision) removes blobs, not rows |
| 6 | CHECK constraints | Service and CHECK could disagree | New empty tables (migration can't fail on them); static guard + integration tests pin each rule |
| 7 | Partial unique photo index | Predicate drift (KI-055) | Same form as Phase 2B photo indexes (no drift); drift check after applying |
| 8 | New enums | Name clash | Names are new; any failure rolls everything back |
| 9 | `specializations` nullable in generated DDL | NULL arrays | CHECK not-null and ≤ 10 entries |
| 10 | Unicode name shape checks | A name the app accepts could fail the CHECK (or the reverse) | The app builds both values with the same normalization the CHECKs test (`IS NFC/NFKC NORMALIZED` is collation-independent); unit tests for every listed script; the CHECKs only reject malformed input |

## 11. Existing-data compatibility

| Area | Impact |
|---|---|
| Existing tables and rows | Untouched except the new FK on `user.employee_id` (expected all NULL; pre-check enforces) |
| Existing indexes | None changed; `user_employee_id_key` already exists |
| Previous release (expand-only) | Keeps working: it never reads the new tables; `user.employee_id` stays nullable and unused |
| Prisma client | `User` gains optional relation fields; explicit `select`s everywhere → behaviour unchanged |
| Authentication, class teachers, students | No change in M1 (AuthContext `employeeId` and the eligibility rule are M3, for approval) |
| `scripts/db-tables.ts` / `db:check` / backup drill | **Must be updated in the same change** (six new tables) |
| Seed / RBAC | No change in M1 (catalog changes are an M2 approval) |
| Free tier | Six small tables; documents in private file storage |
| Drift checks | Expected clean (indexes schema-expressed; CHECKs, `DO` and `SET LOCAL` aren't modelled by Prisma) |

## 12. Apply procedure (steps 1–3 done 2026-11-18 — development and Test migrated; production not started)

1. Owner approves this SQL → create `prisma/migrations/20261112000000_phase3a_hr_core/migration.sql` with exactly this content; update `prisma/schema.prisma`; add `tests/unit/migration-phase3a-hr.test.ts` (static guard: `BEGIN`/`COMMIT`, `lock_timeout`, pre-check, every CHECK, no forward DROP/DELETE/TRUNCATE, no non-transactional statement, no invisible characters); keep the guarded rollback as `prisma/migrations/20261112000000_phase3a_hr_core/ROLLBACK.sql.txt` (not executed by Prisma); add the tables to `scripts/db-tables.ts`; update DATABASE_SCHEMA §5 / DATABASE_RELATIONSHIPS; lint, typecheck, unit tests, build.
2. Separate approval → development: identity + `env:check`, stand-alone pre-check (§6), Neon restore point, `db:deploy`, `migrate status`, drift check, `db:check`.
3. Separate approval → Test: same procedure (Test identity guard).
4. Production: never without explicit approval (Phase 10).
