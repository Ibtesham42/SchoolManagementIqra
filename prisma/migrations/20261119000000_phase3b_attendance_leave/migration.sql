-- Phase 3B: staff attendance & leave — leave types, leave balances (per academic session), leave requests,
-- daily staff attendance, holidays, attendance period locks, and school_setting.weekly_off
-- (PHASE_3B_PLAN.md; owner decisions L1–L12 approved 2026-11-18).
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, CHECK constraints.
-- Expand-only: 6 enums and 6 new tables; the only change to an EXISTING table is one nullable JSONB column on
-- school_setting (metadata-only, no rewrite). Nothing is dropped, renamed or rewritten.
-- Deviation from the plan, for review: overlapping leave is prevented by the SERVICE under the employee row lock,
-- not by a database exclusion constraint (that needs the btree_gist extension and can't express two half-days on
-- one date). Single-school installation (ADR-030): no school_id.
-- Review status: SQL approved by the owner 2026-11-18. Apply to DEVELOPMENT, then Test, with the owner-approved
-- procedure; never production without explicit approval.
--
-- Rollback (comment only — owner-approved, development/Test only, and only while the new tables are empty):
--   DROP TABLE "attendance_period_lock"; DROP TABLE "holiday"; DROP TABLE "employee_attendance";
--   DROP TABLE "leave_request"; DROP TABLE "leave_balance"; DROP TABLE "leave_type";
--   ALTER TABLE "school_setting" DROP CONSTRAINT "school_setting_weekly_off_check";
--   ALTER TABLE "school_setting" DROP COLUMN "weekly_off";
--   DROP TYPE "HolidayAppliesTo", "AttendanceSource", "StaffAttendanceStatus", "HalfDay", "LeaveRequestStatus", "LeaveAppliesTo";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119000000_phase3b_attendance_leave';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "LeaveAppliesTo" AS ENUM ('ALL', 'TEACHING', 'NON_TEACHING');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HalfDay" AS ENUM ('FIRST', 'SECOND');

-- CreateEnum
CREATE TYPE "StaffAttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'ON_LEAVE', 'HOLIDAY', 'WEEKLY_OFF');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('MANUAL', 'IMPORT');

-- CreateEnum
CREATE TYPE "HolidayAppliesTo" AS ENUM ('ALL', 'STAFF', 'STUDENTS');

-- AlterTable
ALTER TABLE "school_setting" ADD COLUMN     "weekly_off" JSONB;

-- CreateTable
CREATE TABLE "leave_type" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "is_paid" BOOLEAN NOT NULL,
    "annual_quota" DECIMAL(4,1),
    "allow_half_day" BOOLEAN NOT NULL DEFAULT true,
    "carry_forward_max" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "applies_to" "LeaveAppliesTo" NOT NULL DEFAULT 'ALL',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balance" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "leave_type_id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "allotted" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "carried_forward" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "used" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "leave_type_id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "half_day" "HalfDay",
    "days" DECIMAL(4,1) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_attendance" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "StaffAttendanceStatus" NOT NULL,
    "check_in" TIME(0),
    "check_out" TIME(0),
    "source" "AttendanceSource" NOT NULL DEFAULT 'MANUAL',
    "leave_request_id" TEXT,
    "correction_reason" VARCHAR(500),
    "marked_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "applies_to" "HolidayAppliesTo" NOT NULL DEFAULT 'ALL',
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_period_lock" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "locked_by_id" TEXT,
    "locked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_period_lock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leave_type_code_key" ON "leave_type"("code");

-- CreateIndex
CREATE UNIQUE INDEX "leave_type_name_key_key" ON "leave_type"("name_key");

-- CreateIndex
CREATE INDEX "leave_balance_academic_session_id_idx" ON "leave_balance"("academic_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balance_employee_id_leave_type_id_academic_session_id_key" ON "leave_balance"("employee_id", "leave_type_id", "academic_session_id");

-- CreateIndex
CREATE INDEX "leave_request_employee_id_from_date_idx" ON "leave_request"("employee_id", "from_date");

-- CreateIndex
CREATE INDEX "leave_request_status_from_date_idx" ON "leave_request"("status", "from_date");

-- CreateIndex
CREATE INDEX "employee_attendance_date_idx" ON "employee_attendance"("date");

-- CreateIndex
CREATE INDEX "employee_attendance_leave_request_id_idx" ON "employee_attendance"("leave_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_attendance_employee_id_date_key" ON "employee_attendance"("employee_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_date_applies_to_key" ON "holiday"("date", "applies_to");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_period_lock_month_key" ON "attendance_period_lock"("month");

-- AddForeignKey
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_leave_request_id_fkey" FOREIGN KEY ("leave_request_id") REFERENCES "leave_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_marked_by_id_fkey" FOREIGN KEY ("marked_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_period_lock" ADD CONSTRAINT "attendance_period_lock_locked_by_id_fkey" FOREIGN KEY ("locked_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── CHECK constraints (hand-written; Prisma does not model them). New, empty tables → validated now. ───
-- school_setting.weekly_off: an object (shape validated by the settings service) or NULL.
ALTER TABLE "school_setting" ADD CONSTRAINT "school_setting_weekly_off_check"
  CHECK ("weekly_off" IS NULL OR jsonb_typeof("weekly_off") = 'object');

-- Leave types: same code and Unicode-name rules as departments (PHASE_3A_M1_SCHEMA_PROPOSAL.md §9).
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_code_format_check" CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$');
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_name_shape_check"
  CHECK ("name" IS NFC NORMALIZED AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> ''
     AND "name" !~ '[\u0001-\u001F\u007F\u200B\uFEFF]');
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_name_key_shape_check"
  CHECK ("name_key" IS NFKC NORMALIZED AND "name_key" = regexp_replace(btrim("name_key"), '\s+', ' ', 'g') AND "name_key" <> ''
     AND "name_key" !~ '[\u0001-\u001F\u007F\u200B\uFEFF]');
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_quota_check"
  CHECK (("annual_quota" IS NULL OR "annual_quota" BETWEEN 0 AND 366) AND "carry_forward_max" BETWEEN 0 AND 366);
-- Unpaid leave (e.g. LOP) never carries forward.
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_unpaid_carry_check" CHECK ("is_paid" OR "carry_forward_max" = 0);
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_version_check" CHECK ("version" >= 1);

-- Balances never negative (L5: paid leave can't exceed the balance — enforced by the service per type).
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_amounts_check"
  CHECK ("allotted" >= 0 AND "carried_forward" >= 0 AND "used" >= 0);
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_version_check" CHECK ("version" >= 1);

-- Requests: a real range; half-days are single days of 0.5 (L10); days within the range; a reason; decision
-- timestamps consistent with the status.
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_dates_check" CHECK ("to_date" >= "from_date");
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_half_day_check"
  CHECK ("half_day" IS NULL OR ("from_date" = "to_date" AND "days" = 0.5));
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_days_check"
  CHECK ("days" > 0 AND "days" <= ("to_date" - "from_date" + 1));
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_reason_check" CHECK (btrim("reason") <> '');
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_decision_check"
  CHECK ((("status" IN ('APPROVED', 'REJECTED')) <= ("decided_at" IS NOT NULL)) AND ("status" <> 'PENDING' OR "decided_at" IS NULL));
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_version_check" CHECK ("version" >= 1);

-- Attendance: times in order; a leave link only on leave days.
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_times_check"
  CHECK ("check_in" IS NULL OR "check_out" IS NULL OR "check_out" >= "check_in");
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_leave_link_check"
  CHECK ("leave_request_id" IS NULL OR "status" IN ('ON_LEAVE', 'HALF_DAY'));
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_version_check" CHECK ("version" >= 1);

ALTER TABLE "holiday" ADD CONSTRAINT "holiday_name_check" CHECK ("name" = btrim("name") AND "name" <> '');

-- A period lock names a month by its first day.
ALTER TABLE "attendance_period_lock" ADD CONSTRAINT "attendance_period_lock_month_check" CHECK (EXTRACT(DAY FROM "month") = 1);

COMMIT;
