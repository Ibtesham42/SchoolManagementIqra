-- Phase 3C: payroll — salary components, salary structures (+ items), maker-checker salary assignment, monthly
-- payroll runs, snapshot salary slips, adjustments, salary payments; optional encrypted PAN / bank details on
-- employee; school_setting.payroll_day_basis (PHASE_3C_PLAN.md; owner decisions P1–P16 + Q approved 2026-11-19).
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, CHECK constraints, partial unique indexes.
-- Expand-only: 7 enums and 7 new tables; changes to EXISTING tables are nullable columns only (6 on employee, 1 on
-- school_setting — metadata-only, no rewrite) plus CHECKs that only constrain those new, all-NULL columns.
-- Nothing is dropped, renamed or rewritten. Salary advances (P9) are deferred: no table.
-- Single-school installation (ADR-030): no school_id.
-- Review status: DRAFT — awaiting the owner's SQL approval. NOT applied to any database. When approved: development
-- first, then Test, with the owner-approved procedure; never production without explicit approval.
--
-- Rollback (comment only — owner-approved, development/Test only, and only while the new tables are empty and the new
-- employee columns are all NULL):
--   DROP TABLE "salary_payment"; DROP TABLE "payroll_adjustment"; DROP TABLE "payroll_slip"; DROP TABLE "payroll_run";
--   DROP TABLE "employee_salary"; DROP TABLE "salary_structure_item"; DROP TABLE "salary_structure"; DROP TABLE "salary_component";
--   ALTER TABLE "employee" DROP CONSTRAINT "employee_pan_pair_check", DROP CONSTRAINT "employee_bank_pair_check";
--   DROP INDEX "employee_pan_hmac_key";
--   ALTER TABLE "employee" DROP COLUMN "pan_enc", DROP COLUMN "pan_hmac", DROP COLUMN "bank_account_enc",
--     DROP COLUMN "bank_account_hmac", DROP COLUMN "bank_ifsc", DROP COLUMN "bank_account_name";
--   ALTER TABLE "school_setting" DROP COLUMN "payroll_day_basis";
--   DROP TYPE "SalaryPaymentMethod", "PayrollAdjustmentKind", "PayrollDayBasis", "PayrollRunStatus", "EmployeeSalaryStatus", "SalaryCalc", "SalaryComponentKind";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261120000000_phase3c_payroll';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "SalaryComponentKind" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "SalaryCalc" AS ENUM ('FIXED', 'PERCENT_OF_BASIC');

-- CreateEnum
CREATE TYPE "EmployeeSalaryStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'PREPARED', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "PayrollDayBasis" AS ENUM ('WORKING_DAYS', 'CALENDAR_DAYS');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentKind" AS ENUM ('BONUS', 'ARREARS', 'OTHER_EARNING', 'OTHER_DEDUCTION');

-- CreateEnum
CREATE TYPE "SalaryPaymentMethod" AS ENUM ('BANK_TRANSFER', 'CHEQUE', 'CASH', 'UPI');

-- AlterTable
ALTER TABLE "school_setting" ADD COLUMN     "payroll_day_basis" "PayrollDayBasis";

-- AlterTable
ALTER TABLE "employee" ADD COLUMN     "bank_account_enc" TEXT,
ADD COLUMN     "bank_account_hmac" VARCHAR(64),
ADD COLUMN     "bank_account_name" VARCHAR(120),
ADD COLUMN     "bank_ifsc" VARCHAR(11),
ADD COLUMN     "pan_enc" TEXT,
ADD COLUMN     "pan_hmac" VARCHAR(64);

-- CreateTable
CREATE TABLE "salary_component" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "kind" "SalaryComponentKind" NOT NULL,
    "calc" "SalaryCalc" NOT NULL,
    "prorated" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "salary_component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structure" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "salary_structure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structure_item" (
    "id" TEXT NOT NULL,
    "structure_id" TEXT NOT NULL,
    "component_id" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "salary_structure_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_salary" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "structure_id" TEXT NOT NULL,
    "basic" DECIMAL(12,2) NOT NULL,
    "effective_from" DATE NOT NULL,
    "status" "EmployeeSalaryStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposed_by_id" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_salary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_run" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "day_basis" "PayrollDayBasis",
    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "total_gross" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_net" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "prepared_by_id" TEXT,
    "prepared_at" TIMESTAMPTZ(3),
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_slip" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "employee_salary_id" TEXT NOT NULL,
    "slip_no" VARCHAR(32),
    "salary_snapshot" JSONB NOT NULL,
    "day_basis" "PayrollDayBasis" NOT NULL,
    "month_days" INTEGER NOT NULL,
    "off_rolls_days" INTEGER NOT NULL,
    "lop_days" DECIMAL(5,1) NOT NULL,
    "paid_days" DECIMAL(5,1) NOT NULL,
    "earnings" JSONB NOT NULL,
    "deductions" JSONB NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,
    "total_deductions" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_slip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustment" (
    "id" TEXT NOT NULL,
    "slip_id" TEXT NOT NULL,
    "kind" "PayrollAdjustmentKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" VARCHAR(500) NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_payment" (
    "id" TEXT NOT NULL,
    "slip_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "SalaryPaymentMethod" NOT NULL,
    "reference" VARCHAR(64),
    "paid_on" DATE NOT NULL,
    "paid_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "salary_payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salary_component_code_key" ON "salary_component"("code");

-- CreateIndex
CREATE UNIQUE INDEX "salary_component_name_key_key" ON "salary_component"("name_key");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structure_name_key_key" ON "salary_structure"("name_key");

-- CreateIndex
CREATE INDEX "salary_structure_item_component_id_idx" ON "salary_structure_item"("component_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structure_item_structure_id_component_id_key" ON "salary_structure_item"("structure_id", "component_id");

-- CreateIndex
CREATE INDEX "employee_salary_employee_id_effective_from_idx" ON "employee_salary"("employee_id", "effective_from");

-- CreateIndex
CREATE INDEX "employee_salary_structure_id_idx" ON "employee_salary"("structure_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_run_month_key" ON "payroll_run"("month");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_slip_slip_no_key" ON "payroll_slip"("slip_no");

-- CreateIndex
CREATE INDEX "payroll_slip_employee_id_idx" ON "payroll_slip"("employee_id");

-- CreateIndex
CREATE INDEX "payroll_slip_employee_salary_id_idx" ON "payroll_slip"("employee_salary_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_slip_run_id_employee_id_key" ON "payroll_slip"("run_id", "employee_id");

-- CreateIndex
CREATE INDEX "payroll_adjustment_slip_id_idx" ON "payroll_adjustment"("slip_id");

-- CreateIndex
CREATE INDEX "salary_payment_slip_id_idx" ON "salary_payment"("slip_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_pan_hmac_key" ON "employee"("pan_hmac");

-- AddForeignKey
ALTER TABLE "salary_structure_item" ADD CONSTRAINT "salary_structure_item_structure_id_fkey" FOREIGN KEY ("structure_id") REFERENCES "salary_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structure_item" ADD CONSTRAINT "salary_structure_item_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "salary_component"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_structure_id_fkey" FOREIGN KEY ("structure_id") REFERENCES "salary_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_prepared_by_id_fkey" FOREIGN KEY ("prepared_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_slip" ADD CONSTRAINT "payroll_slip_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_slip" ADD CONSTRAINT "payroll_slip_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_slip" ADD CONSTRAINT "payroll_slip_employee_salary_id_fkey" FOREIGN KEY ("employee_salary_id") REFERENCES "employee_salary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustment" ADD CONSTRAINT "payroll_adjustment_slip_id_fkey" FOREIGN KEY ("slip_id") REFERENCES "payroll_slip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustment" ADD CONSTRAINT "payroll_adjustment_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_payment" ADD CONSTRAINT "salary_payment_slip_id_fkey" FOREIGN KEY ("slip_id") REFERENCES "payroll_slip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_payment" ADD CONSTRAINT "salary_payment_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Hand-written (Prisma does not model CHECKs or partial unique indexes). New tables are empty → validated now;
-- the employee / school_setting CHECKs only constrain the NEW nullable columns (all NULL today) → validated now. ───

-- Master data names / codes: same shape rules as departments and leave types (any script, NFC, single spaces).
ALTER TABLE "salary_component" ADD CONSTRAINT "salary_component_code_format_check" CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$');
ALTER TABLE "salary_component" ADD CONSTRAINT "salary_component_name_shape_check"
  CHECK ("name" IS NFC NORMALIZED AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> ''
     AND "name" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "salary_component" ADD CONSTRAINT "salary_component_name_key_shape_check"
  CHECK ("name_key" IS NFKC NORMALIZED AND "name_key" = regexp_replace(btrim("name_key"), '\s+', ' ', 'g') AND "name_key" <> ''
     AND "name_key" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "salary_component" ADD CONSTRAINT "salary_component_version_check" CHECK ("version" >= 1);

ALTER TABLE "salary_structure" ADD CONSTRAINT "salary_structure_name_shape_check"
  CHECK ("name" IS NFC NORMALIZED AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> ''
     AND "name" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "salary_structure" ADD CONSTRAINT "salary_structure_name_key_shape_check"
  CHECK ("name_key" IS NFKC NORMALIZED AND "name_key" = regexp_replace(btrim("name_key"), '\s+', ' ', 'g') AND "name_key" <> ''
     AND "name_key" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "salary_structure" ADD CONSTRAINT "salary_structure_version_check" CHECK ("version" >= 1);

-- Item values are never negative (percent ≤ 100 is checked by the service against the component's calc).
ALTER TABLE "salary_structure_item" ADD CONSTRAINT "salary_structure_item_value_check" CHECK ("value" >= 0);
ALTER TABLE "salary_structure_item" ADD CONSTRAINT "salary_structure_item_sort_check" CHECK ("sort_order" BETWEEN 0 AND 999);

-- Salary assignment (P7): month-start dates; a decision has a decider and a time, a proposal has neither.
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_basic_check" CHECK ("basic" >= 0);
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_effective_from_check" CHECK (EXTRACT(DAY FROM "effective_from") = 1);
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_decision_check"
  CHECK ((("status" IN ('APPROVED', 'REJECTED')) = ("decided_at" IS NOT NULL))
     AND ("status" <> 'REJECTED' OR "decision_note" IS NOT NULL));
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_version_check" CHECK ("version" >= 1);
-- At most one pending proposal per employee, and one approved salary per employee and month.
CREATE UNIQUE INDEX "employee_salary_one_pending_key" ON "employee_salary"("employee_id") WHERE "status" = 'PROPOSED';
CREATE UNIQUE INDEX "employee_salary_one_approved_per_month_key" ON "employee_salary"("employee_id", "effective_from") WHERE "status" = 'APPROVED';

-- Runs: a month is named by its first day; totals reconcile; each status carries its actor timestamps.
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_month_check" CHECK (EXTRACT(DAY FROM "month") = 1);
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_totals_check"
  CHECK ("employee_count" >= 0 AND "total_gross" >= 0 AND "total_deductions" >= 0 AND "total_net" >= 0
     AND "total_net" = "total_gross" - "total_deductions");
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_status_check"
  CHECK (("status" = 'DRAFT' OR ("prepared_at" IS NOT NULL AND "day_basis" IS NOT NULL))
     AND (("status" IN ('APPROVED', 'PAID')) = ("approved_at" IS NOT NULL)));
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_counters_check" CHECK ("reopen_count" >= 0 AND "version" >= 1);

-- Slips: days within the month, net = gross − deductions, never negative (skill: recovery is capped first).
ALTER TABLE "payroll_slip" ADD CONSTRAINT "payroll_slip_days_check"
  CHECK ("month_days" BETWEEN 0 AND 31 AND "off_rolls_days" BETWEEN 0 AND "month_days"
     AND "lop_days" >= 0 AND "paid_days" >= 0 AND "paid_days" + "lop_days" + "off_rolls_days" = "month_days");
ALTER TABLE "payroll_slip" ADD CONSTRAINT "payroll_slip_amounts_check"
  CHECK ("gross" >= 0 AND "total_deductions" >= 0 AND "net" >= 0 AND "net" = "gross" - "total_deductions");
ALTER TABLE "payroll_slip" ADD CONSTRAINT "payroll_slip_json_check"
  CHECK (jsonb_typeof("salary_snapshot") = 'object' AND jsonb_typeof("earnings") = 'array' AND jsonb_typeof("deductions") = 'array');
ALTER TABLE "payroll_slip" ADD CONSTRAINT "payroll_slip_slip_no_check" CHECK ("slip_no" IS NULL OR ("slip_no" = btrim("slip_no") AND "slip_no" <> ''));
ALTER TABLE "payroll_slip" ADD CONSTRAINT "payroll_slip_version_check" CHECK ("version" >= 1);

ALTER TABLE "payroll_adjustment" ADD CONSTRAINT "payroll_adjustment_amount_check" CHECK ("amount" > 0);
ALTER TABLE "payroll_adjustment" ADD CONSTRAINT "payroll_adjustment_note_check" CHECK ("note" = btrim("note") AND length("note") >= 3);

ALTER TABLE "salary_payment" ADD CONSTRAINT "salary_payment_amount_check" CHECK ("amount" > 0);
ALTER TABLE "salary_payment" ADD CONSTRAINT "salary_payment_reference_check"
  CHECK ("reference" IS NULL OR ("reference" = btrim("reference") AND "reference" <> ''));
-- A bank / UPI / cheque reference is recorded once per method (cash may have none).
CREATE UNIQUE INDEX "salary_payment_method_reference_key" ON "salary_payment"("method", "reference") WHERE "reference" IS NOT NULL;

-- Employee PAN / bank (P8): ciphertext and HMAC come in pairs; HMACs are 64 lowercase hex; IFSC shape.
ALTER TABLE "employee" ADD CONSTRAINT "employee_pan_pair_check"
  CHECK (("pan_enc" IS NULL) = ("pan_hmac" IS NULL) AND ("pan_hmac" IS NULL OR "pan_hmac" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "employee" ADD CONSTRAINT "employee_bank_pair_check"
  CHECK (("bank_account_enc" IS NULL) = ("bank_account_hmac" IS NULL)
     AND ("bank_account_hmac" IS NULL OR "bank_account_hmac" ~ '^[0-9a-f]{64}$')
     AND ("bank_ifsc" IS NULL OR "bank_ifsc" ~ '^[A-Z]{4}0[A-Z0-9]{6}$')
     AND ("bank_account_name" IS NULL OR ("bank_account_name" = btrim("bank_account_name") AND "bank_account_name" <> '')));

COMMIT;
