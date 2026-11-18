-- Phase 2b: admissions (applications, applicant guardians, documents) and students (students, guardians,
-- links, session enrollments, roll-number batches, status history). Design: docs/PHASE_2B_STUDENTS_DESIGN.md.
-- Generated offline by `prisma migrate diff --from-schema <schema after 20261110000000> --to-schema
-- prisma/schema.prisma --script` (no database touched), then hand-edited:
--   * wrapped in one transaction;
--   * CHECK constraints appended (Prisma does not model them), validated immediately (all tables new/empty);
--   * partial unique indexes are schema-expressed (partialIndexes preview, ADR-034), so drift checks keep them.
-- Expand-only: 8 enum types, 10 new tables; on EXISTING tables only (a) one new column
-- "school_setting"."required_admission_documents" with a constant default (no table rewrite; owner decision D10)
-- and (b) one new unique index on "section" ("section_id_academic_session_id_key", target of the enrollment's
-- composite FK — 0 section rows on development; brief SHARE lock). Nothing is dropped, renamed or updated.
-- Aadhaar and medical data are NOT collected in this phase (design D6). Single school (ADR-030): no school_id.
-- Review status: design approved by the owner 2026-11-10 (D1–D12). Apply to DEVELOPMENT only after the owner's
-- explicit approval of the read-only pre-check; Test and Production need separate approval.
--
-- Rollback (only while these tables are empty; otherwise Neon point-in-time restore):
--   BEGIN;
--   DROP TABLE "student_roll_number", "roll_number_batch", "student_status_change", "student_document",
--              "student_enrollment", "student_guardian", "admission_guardian", "admission_application",
--              "guardian", "student";
--   DROP INDEX "section_id_academic_session_id_key";
--   ALTER TABLE "school_setting" DROP COLUMN "required_admission_documents";
--   DROP TYPE "AdmissionStatus", "Gender", "GuardianRelation", "StudentStatus", "EnrollmentStatus",
--             "StudentDocumentType", "RollNumberBatchStatus", "RollNumberSource";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261111000000_phase2b_admissions_students';
--   COMMIT;
-- and revert prisma/schema.prisma in the same change. Never edit this file after it has been applied.

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;

-- CreateEnum
CREATE TYPE "AdmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "GuardianRelation" AS ENUM ('FATHER', 'MOTHER', 'GUARDIAN', 'OTHER');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'TRANSFERRED', 'GRADUATED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'PROMOTED', 'DETAINED', 'LEFT');

-- CreateEnum
CREATE TYPE "StudentDocumentType" AS ENUM ('BIRTH_CERTIFICATE', 'TRANSFER_CERTIFICATE', 'PREVIOUS_MARKSHEET', 'PHOTO', 'OTHER');

-- CreateEnum
CREATE TYPE "RollNumberBatchStatus" AS ENUM ('DRAFT', 'FINALIZED');

-- CreateEnum
CREATE TYPE "RollNumberSource" AS ENUM ('GENERATED', 'APPENDED', 'CORRECTED');

-- AlterTable
ALTER TABLE "school_setting" ADD COLUMN     "required_admission_documents" "StudentDocumentType"[] DEFAULT ARRAY['PHOTO', 'BIRTH_CERTIFICATE']::"StudentDocumentType"[];

-- CreateTable
CREATE TABLE "admission_application" (
    "id" TEXT NOT NULL,
    "application_no" VARCHAR(32),
    "academic_session_id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "section_id" TEXT,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "first_name" VARCHAR(60) NOT NULL,
    "middle_name" VARCHAR(60),
    "last_name" VARCHAR(60),
    "full_name" VARCHAR(185) NOT NULL,
    "full_name_normalized" VARCHAR(185) NOT NULL,
    "dob" DATE NOT NULL,
    "gender" "Gender" NOT NULL,
    "phone" VARCHAR(10),
    "email" VARCHAR(254),
    "address" JSONB,
    "previous_school" JSONB,
    "admission_date" DATE,
    "duplicate_matches" JSONB,
    "duplicate_override" VARCHAR(500),
    "rejection_reason" VARCHAR(500),
    "created_by_id" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "review_started_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_id" TEXT,
    "student_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admission_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_guardian" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "relation" "GuardianRelation" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(10) NOT NULL,
    "alt_phone" VARCHAR(10),
    "email" VARCHAR(254),
    "occupation" VARCHAR(80),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_emergency_contact" BOOLEAN NOT NULL DEFAULT false,
    "link_guardian_id" TEXT,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admission_guardian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student" (
    "id" TEXT NOT NULL,
    "student_code" VARCHAR(32) NOT NULL,
    "admission_no" VARCHAR(32) NOT NULL,
    "first_name" VARCHAR(60) NOT NULL,
    "middle_name" VARCHAR(60),
    "last_name" VARCHAR(60),
    "full_name" VARCHAR(185) NOT NULL,
    "full_name_normalized" VARCHAR(185) NOT NULL,
    "dob" DATE NOT NULL,
    "gender" "Gender" NOT NULL,
    "phone" VARCHAR(10),
    "email" VARCHAR(254),
    "address" JSONB,
    "previous_school" JSONB,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "admission_date" DATE NOT NULL,
    "admitted_session_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardian" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(10) NOT NULL,
    "alt_phone" VARCHAR(10),
    "email" VARCHAR(254),
    "occupation" VARCHAR(80),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "guardian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_guardian" (
    "student_id" TEXT NOT NULL,
    "guardian_id" TEXT NOT NULL,
    "relation" "GuardianRelation" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_emergency_contact" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_guardian_pkey" PRIMARY KEY ("student_id","guardian_id")
);

-- CreateTable
CREATE TABLE "student_document" (
    "id" TEXT NOT NULL,
    "application_id" TEXT,
    "student_id" TEXT,
    "type" "StudentDocumentType" NOT NULL,
    "file_id" TEXT NOT NULL,
    "label" VARCHAR(80),
    "uploaded_by_id" TEXT,
    "verified_by_id" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "student_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_enrollment" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "enrolled_on" DATE NOT NULL,
    "left_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roll_number_batch" (
    "id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "status" "RollNumberBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "generated_by_id" TEXT,
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_by_id" TEXT,
    "finalized_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roll_number_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_roll_number" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "roll_number" SMALLINT NOT NULL,
    "source" "RollNumberSource" NOT NULL DEFAULT 'GENERATED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_roll_number_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_status_change" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "from_status" "StudentStatus" NOT NULL,
    "to_status" "StudentStatus" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "effective_date" DATE NOT NULL,
    "acted_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_status_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admission_application_application_no_key" ON "admission_application"("application_no");

-- CreateIndex
CREATE UNIQUE INDEX "admission_application_student_id_key" ON "admission_application"("student_id");

-- CreateIndex
CREATE INDEX "admission_application_academic_session_id_status_idx" ON "admission_application"("academic_session_id", "status");

-- CreateIndex
CREATE INDEX "admission_application_full_name_normalized_dob_idx" ON "admission_application"("full_name_normalized", "dob");

-- CreateIndex
CREATE INDEX "admission_application_status_updated_at_idx" ON "admission_application"("status", "updated_at");

-- CreateIndex
CREATE INDEX "admission_guardian_phone_idx" ON "admission_guardian"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "admission_guardian_application_parent_key" ON "admission_guardian"("application_id", "relation") WHERE (relation IN ('FATHER', 'MOTHER'));

-- CreateIndex
CREATE UNIQUE INDEX "admission_guardian_application_primary_key" ON "admission_guardian"("application_id") WHERE (is_primary);

-- CreateIndex
CREATE UNIQUE INDEX "student_student_code_key" ON "student"("student_code");

-- CreateIndex
CREATE UNIQUE INDEX "student_admission_no_key" ON "student"("admission_no");

-- CreateIndex
CREATE INDEX "student_full_name_normalized_dob_idx" ON "student"("full_name_normalized", "dob");

-- CreateIndex
CREATE INDEX "student_status_idx" ON "student"("status");

-- CreateIndex
CREATE INDEX "guardian_phone_idx" ON "guardian"("phone");

-- CreateIndex
CREATE INDEX "student_guardian_guardian_id_idx" ON "student_guardian"("guardian_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_guardian_student_primary_key" ON "student_guardian"("student_id") WHERE (is_primary);

-- CreateIndex
CREATE UNIQUE INDEX "student_document_file_id_key" ON "student_document"("file_id");

-- CreateIndex
CREATE INDEX "student_document_application_id_idx" ON "student_document"("application_id");

-- CreateIndex
CREATE INDEX "student_document_student_id_idx" ON "student_document"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_document_application_photo_key" ON "student_document"("application_id") WHERE (type = 'PHOTO' AND deleted_at IS NULL AND application_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "student_document_student_photo_key" ON "student_document"("student_id") WHERE (type = 'PHOTO' AND deleted_at IS NULL AND student_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "student_enrollment_section_id_status_idx" ON "student_enrollment"("section_id", "status");

-- CreateIndex
CREATE INDEX "student_enrollment_academic_session_id_status_idx" ON "student_enrollment"("academic_session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "student_enrollment_student_id_academic_session_id_key" ON "student_enrollment"("student_id", "academic_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "roll_number_batch_section_id_key" ON "roll_number_batch"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_roll_number_enrollment_id_key" ON "student_roll_number"("enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_roll_number_batch_id_roll_number_key" ON "student_roll_number"("batch_id", "roll_number");

-- CreateIndex
CREATE INDEX "student_status_change_student_id_created_at_idx" ON "student_status_change"("student_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "section_id_academic_session_id_key" ON "section"("id", "academic_session_id");

-- AddForeignKey
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "school_class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_guardian" ADD CONSTRAINT "admission_guardian_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "admission_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_guardian" ADD CONSTRAINT "admission_guardian_link_guardian_id_fkey" FOREIGN KEY ("link_guardian_id") REFERENCES "guardian"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student" ADD CONSTRAINT "student_admitted_session_id_fkey" FOREIGN KEY ("admitted_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_guardian" ADD CONSTRAINT "student_guardian_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_guardian" ADD CONSTRAINT "student_guardian_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardian"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_document" ADD CONSTRAINT "student_document_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "admission_application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_document" ADD CONSTRAINT "student_document_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_document" ADD CONSTRAINT "student_document_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_document" ADD CONSTRAINT "student_document_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_document" ADD CONSTRAINT "student_document_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_enrollment" ADD CONSTRAINT "student_enrollment_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_enrollment" ADD CONSTRAINT "student_enrollment_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_enrollment" ADD CONSTRAINT "student_enrollment_section_id_academic_session_id_fkey" FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roll_number_batch" ADD CONSTRAINT "roll_number_batch_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roll_number_batch" ADD CONSTRAINT "roll_number_batch_generated_by_id_fkey" FOREIGN KEY ("generated_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roll_number_batch" ADD CONSTRAINT "roll_number_batch_finalized_by_id_fkey" FOREIGN KEY ("finalized_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_roll_number" ADD CONSTRAINT "student_roll_number_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "roll_number_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_roll_number" ADD CONSTRAINT "student_roll_number_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "student_enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_status_change" ADD CONSTRAINT "student_status_change_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_status_change" ADD CONSTRAINT "student_status_change_acted_by_id_fkey" FOREIGN KEY ("acted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── CHECK constraints (hand-written; Prisma does not model them). New, empty tables → validated
-- immediately. Keep in step with src/modules/admissions|students rules and docs/DATABASE_SCHEMA.md. ───

-- admission_application
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_version_check" CHECK ("version" >= 1);
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_dob_check" CHECK ("dob" >= DATE '1990-01-01');
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_name_check"
  CHECK ("full_name_normalized" = btrim("full_name_normalized") AND "full_name_normalized" <> '' AND "first_name" <> '');
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^[0-9]{10}$');
-- Every non-draft application has its number (assigned on first submit).
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_number_check"
  CHECK ("status" = 'DRAFT' OR "application_no" IS NOT NULL);
-- APPROVED ⇔ a registered student; approval needs the section, the decision time and the admission date.
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_approved_check"
  CHECK (("status" = 'APPROVED') = ("student_id" IS NOT NULL)
         AND ("status" <> 'APPROVED' OR ("section_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "admission_date" IS NOT NULL)));
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_rejected_check"
  CHECK ("status" <> 'REJECTED' OR ("rejection_reason" IS NOT NULL AND btrim("rejection_reason") <> '' AND "decided_at" IS NOT NULL));

-- admission_guardian / guardian: 10-digit phone numbers (normalised by the schema layer).
ALTER TABLE "admission_guardian" ADD CONSTRAINT "admission_guardian_phone_check"
  CHECK ("phone" ~ '^[0-9]{10}$' AND ("alt_phone" IS NULL OR "alt_phone" ~ '^[0-9]{10}$') AND btrim("name") <> '');
ALTER TABLE "guardian" ADD CONSTRAINT "guardian_phone_check"
  CHECK ("phone" ~ '^[0-9]{10}$' AND ("alt_phone" IS NULL OR "alt_phone" ~ '^[0-9]{10}$') AND btrim("name") <> '');

-- student
ALTER TABLE "student" ADD CONSTRAINT "student_version_check" CHECK ("version" >= 1);
ALTER TABLE "student" ADD CONSTRAINT "student_dob_check" CHECK ("dob" >= DATE '1990-01-01');
ALTER TABLE "student" ADD CONSTRAINT "student_name_check"
  CHECK ("full_name_normalized" = btrim("full_name_normalized") AND "full_name_normalized" <> '' AND "first_name" <> '');
ALTER TABLE "student" ADD CONSTRAINT "student_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^[0-9]{10}$');
ALTER TABLE "student" ADD CONSTRAINT "student_codes_check" CHECK (btrim("student_code") <> '' AND btrim("admission_no") <> '');

-- student_document
ALTER TABLE "student_document" ADD CONSTRAINT "student_document_owner_check" CHECK ("application_id" IS NOT NULL OR "student_id" IS NOT NULL);
ALTER TABLE "student_document" ADD CONSTRAINT "student_document_label_check" CHECK ("type" <> 'OTHER' OR ("label" IS NOT NULL AND btrim("label") <> ''));
-- verified_by may become NULL (user removed → SET NULL), but never without a verification time.
ALTER TABLE "student_document" ADD CONSTRAINT "student_document_verified_check" CHECK ("verified_by_id" IS NULL OR "verified_at" IS NOT NULL);

-- student_enrollment
ALTER TABLE "student_enrollment" ADD CONSTRAINT "student_enrollment_left_check"
  CHECK (("left_on" IS NULL OR "left_on" >= "enrolled_on") AND ("status" <> 'LEFT' OR "left_on" IS NOT NULL));

-- roll numbers
ALTER TABLE "roll_number_batch" ADD CONSTRAINT "roll_number_batch_version_check" CHECK ("version" >= 1);
ALTER TABLE "roll_number_batch" ADD CONSTRAINT "roll_number_batch_finalized_check" CHECK ("status" <> 'FINALIZED' OR "finalized_at" IS NOT NULL);
ALTER TABLE "student_roll_number" ADD CONSTRAINT "student_roll_number_positive_check" CHECK ("roll_number" >= 1);

-- student_status_change: a real change with a reason.
ALTER TABLE "student_status_change" ADD CONSTRAINT "student_status_change_check" CHECK ("from_status" <> "to_status" AND btrim("reason") <> '');

-- school_setting: the D10 list is always present (Prisma maps list columns as nullable, so NOT NULL
-- is a CHECK here — no schema drift); the one existing row receives the default.
ALTER TABLE "school_setting" ADD CONSTRAINT "school_setting_required_admission_documents_check"
  CHECK ("required_admission_documents" IS NOT NULL);

COMMIT;
