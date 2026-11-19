-- Phase 4A: teaching structure and student attendance — subjects, class subjects per session, optional subjects per
-- student, teacher allocations (→ employee), periods (bell schedule per weekday), timetable slots, daily student
-- attendance, and school_setting.student_weekly_off (PHASE_4_PLAN.md; owner decisions AC1–AC20 approved 2026-11-19).
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, CHECK constraints.
-- Expand-only: 3 enums and 7 new tables. Changes to EXISTING tables: one nullable JSONB column (+ CHECK) on
-- school_setting, and one UNIQUE index on student_enrollment(id, academic_session_id) — the target of the composite
-- foreign keys that keep student subjects and attendance in the enrollment's own session. Building that index takes
-- a short SHARE lock on student_enrollment (writes wait; reads continue); the table is small.
-- Nothing is dropped, renamed or rewritten. Single-school installation (ADR-030): no school_id.
-- Requires migration 20261120000000_phase3c_payroll before it (same schema file); both are drafts.
-- Review status: DRAFT — awaiting the owner's SQL approval. NOT applied to any database. When approved: development
-- first, then Test, with the owner-approved procedure; never production without explicit approval.
--
-- Rollback (comment only — owner-approved, development/Test only, and only while the new tables are empty):
--   DROP TABLE "student_attendance"; DROP TABLE "timetable_slot"; DROP TABLE "period"; DROP TABLE "teacher_allocation";
--   DROP TABLE "student_subject"; DROP TABLE "class_subject"; DROP TABLE "subject";
--   DROP INDEX "student_enrollment_id_academic_session_id_key";
--   ALTER TABLE "school_setting" DROP CONSTRAINT "school_setting_student_weekly_off_check";
--   ALTER TABLE "school_setting" DROP COLUMN "student_weekly_off";
--   DROP TYPE "StudentAttendanceStatus", "PeriodKind", "SubjectKind";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000000_phase4a_teaching_attendance';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "SubjectKind" AS ENUM ('SCHOLASTIC', 'CO_SCHOLASTIC');

-- CreateEnum
CREATE TYPE "PeriodKind" AS ENUM ('TEACHING', 'BREAK');

-- CreateEnum
CREATE TYPE "StudentAttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'EXCUSED');

-- AlterTable
ALTER TABLE "school_setting" ADD COLUMN     "student_weekly_off" JSONB;

-- CreateTable
CREATE TABLE "subject" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "kind" "SubjectKind" NOT NULL DEFAULT 'SCHOLASTIC',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_subject" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "class_subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_subject" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "class_subject_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_allocation" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "class_subject_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teacher_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "period" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "number" SMALLINT NOT NULL,
    "label" VARCHAR(40),
    "kind" "PeriodKind" NOT NULL DEFAULT 'TEACHING',
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slot" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "class_subject_id" TEXT NOT NULL,
    "employee_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "timetable_slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_attendance" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "StudentAttendanceStatus" NOT NULL,
    "correction_reason" VARCHAR(500),
    "marked_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subject_code_key" ON "subject"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subject_name_key_key" ON "subject"("name_key");

-- CreateIndex
CREATE INDEX "class_subject_class_id_idx" ON "class_subject"("class_id");

-- CreateIndex
CREATE INDEX "class_subject_subject_id_idx" ON "class_subject"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_subject_academic_session_id_class_id_subject_id_key" ON "class_subject"("academic_session_id", "class_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_subject_id_academic_session_id_key" ON "class_subject"("id", "academic_session_id");

-- CreateIndex
CREATE INDEX "student_subject_class_subject_id_idx" ON "student_subject"("class_subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_subject_enrollment_id_class_subject_id_key" ON "student_subject"("enrollment_id", "class_subject_id");

-- CreateIndex
CREATE INDEX "teacher_allocation_employee_id_academic_session_id_idx" ON "teacher_allocation"("employee_id", "academic_session_id");

-- CreateIndex
CREATE INDEX "teacher_allocation_class_subject_id_idx" ON "teacher_allocation"("class_subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_allocation_section_id_class_subject_id_key" ON "teacher_allocation"("section_id", "class_subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "period_academic_session_id_day_of_week_number_key" ON "period"("academic_session_id", "day_of_week", "number");

-- CreateIndex
CREATE UNIQUE INDEX "period_id_academic_session_id_key" ON "period"("id", "academic_session_id");

-- CreateIndex
CREATE INDEX "timetable_slot_period_id_idx" ON "timetable_slot"("period_id");

-- CreateIndex
CREATE INDEX "timetable_slot_class_subject_id_idx" ON "timetable_slot"("class_subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slot_section_id_period_id_key" ON "timetable_slot"("section_id", "period_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slot_teacher_period_key" ON "timetable_slot"("employee_id", "period_id") WHERE (employee_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "student_attendance_academic_session_id_date_idx" ON "student_attendance"("academic_session_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "student_attendance_enrollment_id_date_key" ON "student_attendance"("enrollment_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "student_enrollment_id_academic_session_id_key" ON "student_enrollment"("id", "academic_session_id");

-- AddForeignKey
ALTER TABLE "class_subject" ADD CONSTRAINT "class_subject_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subject" ADD CONSTRAINT "class_subject_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "school_class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subject" ADD CONSTRAINT "class_subject_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_subject" ADD CONSTRAINT "student_subject_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_subject" ADD CONSTRAINT "student_subject_enrollment_id_academic_session_id_fkey" FOREIGN KEY ("enrollment_id", "academic_session_id") REFERENCES "student_enrollment"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_subject" ADD CONSTRAINT "student_subject_class_subject_id_academic_session_id_fkey" FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_allocation" ADD CONSTRAINT "teacher_allocation_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_allocation" ADD CONSTRAINT "teacher_allocation_section_id_academic_session_id_fkey" FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_allocation" ADD CONSTRAINT "teacher_allocation_class_subject_id_academic_session_id_fkey" FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_allocation" ADD CONSTRAINT "teacher_allocation_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "period" ADD CONSTRAINT "period_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_section_id_academic_session_id_fkey" FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_period_id_academic_session_id_fkey" FOREIGN KEY ("period_id", "academic_session_id") REFERENCES "period"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_class_subject_id_academic_session_id_fkey" FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_attendance" ADD CONSTRAINT "student_attendance_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_attendance" ADD CONSTRAINT "student_attendance_enrollment_id_academic_session_id_fkey" FOREIGN KEY ("enrollment_id", "academic_session_id") REFERENCES "student_enrollment"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_attendance" ADD CONSTRAINT "student_attendance_marked_by_id_fkey" FOREIGN KEY ("marked_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Hand-written (Prisma does not model CHECKs). New tables are empty → validated now; the school_setting CHECK only
-- constrains the new, all-NULL column → validated now. ───

-- Subjects: same code and Unicode-name rules as departments and leave types (any script, NFC, single spaces).
ALTER TABLE "subject" ADD CONSTRAINT "subject_code_format_check" CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$');
ALTER TABLE "subject" ADD CONSTRAINT "subject_name_shape_check"
  CHECK ("name" IS NFC NORMALIZED AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> ''
     AND "name" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "subject" ADD CONSTRAINT "subject_name_key_shape_check"
  CHECK ("name_key" IS NFKC NORMALIZED AND "name_key" = regexp_replace(btrim("name_key"), '\s+', ' ', 'g') AND "name_key" <> ''
     AND "name_key" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "subject" ADD CONSTRAINT "subject_version_check" CHECK ("version" >= 1);

ALTER TABLE "class_subject" ADD CONSTRAINT "class_subject_sort_check" CHECK ("sort_order" BETWEEN 0 AND 999);
ALTER TABLE "class_subject" ADD CONSTRAINT "class_subject_version_check" CHECK ("version" >= 1);

ALTER TABLE "teacher_allocation" ADD CONSTRAINT "teacher_allocation_version_check" CHECK ("version" >= 1);

-- Periods: 0 = Sunday … 6 = Saturday; at most 15 per day; a period ends after it starts.
ALTER TABLE "period" ADD CONSTRAINT "period_day_check" CHECK ("day_of_week" BETWEEN 0 AND 6);
ALTER TABLE "period" ADD CONSTRAINT "period_number_check" CHECK ("number" BETWEEN 1 AND 15);
ALTER TABLE "period" ADD CONSTRAINT "period_times_check" CHECK ("end_time" > "start_time");
ALTER TABLE "period" ADD CONSTRAINT "period_label_check" CHECK ("label" IS NULL OR ("label" = btrim("label") AND "label" <> ''));
ALTER TABLE "period" ADD CONSTRAINT "period_version_check" CHECK ("version" >= 1);

ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_version_check" CHECK ("version" >= 1);

ALTER TABLE "student_attendance" ADD CONSTRAINT "student_attendance_reason_check"
  CHECK ("correction_reason" IS NULL OR ("correction_reason" = btrim("correction_reason") AND length("correction_reason") >= 3));
ALTER TABLE "student_attendance" ADD CONSTRAINT "student_attendance_version_check" CHECK ("version" >= 1);

-- Student weekly off (AC6): same shape as the staff weekly_off (validated by the settings service).
ALTER TABLE "school_setting" ADD CONSTRAINT "school_setting_student_weekly_off_check"
  CHECK ("student_weekly_off" IS NULL OR jsonb_typeof("student_weekly_off") = 'object');

COMMIT;
