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
-- Review status: SQL approved by the owner 2026-11-18 (PHASE_3A_M1_SCHEMA_PROPOSAL.md). Apply to DEVELOPMENT, then
-- Test, only after the owner's separate approval for each branch; never production without explicit approval.
--
-- Rollback: use ONLY the guarded rollback script (ROLLBACK.sql.txt in this folder) — it refuses to drop anything
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
