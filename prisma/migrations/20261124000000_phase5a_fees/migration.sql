-- Phase 5A: fees — categories, installments, structures, concessions, late-fee rules, per-student charges, invoices,
-- payments (= receipts) and allocations (PHASE_5_PLAN.md FC1–FC26, approved by the owner 2026-11-20).
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, partial unique indexes, CHECK constraints,
-- and two triggers that keep issued receipts and their allocations unchangeable (security review 5A M1).
-- Expand-only: 12 enums and 13 new tables. No existing table or column is changed (new foreign keys point AT
-- academic_session, school_class, student, student_enrollment and user). Per-student rows reference the enrollment by
-- (student_id, academic_session_id), which is already unique on student_enrollment. Nothing is dropped or renamed.
-- Review status: SQL approved by the owner 2026-11-20.
--
-- Rollback (comment only — development/Test, only while the new tables are empty):
--   DROP TABLE "fee_payment_allocation", "fee_payment", "fee_invoice_item", "fee_invoice", "student_fee_charge",
--     "late_fee_rule", "student_concession", "fee_concession_category", "fee_concession", "fee_structure_item",
--     "fee_structure", "fee_installment", "fee_category";
--   DROP FUNCTION fee_payment_guard(), fee_payment_allocation_guard();
--   DROP TYPE "FeePaymentStatus", "FeePaymentMethod", "FeeInvoiceItemKind", "FeeInvoiceStatus", "FeeInvoiceKind",
--     "FeeChargeSource", "LateFeeCalc", "StudentConcessionStatus", "FeeCalc", "FeeConcessionKind", "FeeAppliesTo",
--     "FeeCategoryKind";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261124000000_phase5a_fees';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';
-- CreateEnum
CREATE TYPE "FeeCategoryKind" AS ENUM ('REGULAR', 'ONE_TIME', 'TRANSPORT', 'LATE_FEE', 'OPENING_BALANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "FeeAppliesTo" AS ENUM ('ALL', 'NEW_ADMISSION', 'EXISTING');

-- CreateEnum
CREATE TYPE "FeeConcessionKind" AS ENUM ('CONCESSION', 'SCHOLARSHIP', 'DISCOUNT', 'WAIVER');

-- CreateEnum
CREATE TYPE "FeeCalc" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "StudentConcessionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "LateFeeCalc" AS ENUM ('FLAT', 'PER_DAY', 'PERCENT');

-- CreateEnum
CREATE TYPE "FeeChargeSource" AS ENUM ('MANUAL', 'TRANSPORT');

-- CreateEnum
CREATE TYPE "FeeInvoiceKind" AS ENUM ('INSTALLMENT', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "FeeInvoiceStatus" AS ENUM ('ISSUED', 'PARTIAL', 'PAID', 'WAIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FeeInvoiceItemKind" AS ENUM ('STRUCTURE', 'CHARGE', 'LATE_FEE', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "FeePaymentMethod" AS ENUM ('CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE', 'CARD');

-- CreateEnum
CREATE TYPE "FeePaymentStatus" AS ENUM ('SUCCESS', 'CANCELLED');

-- CreateTable
CREATE TABLE "fee_category" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "kind" "FeeCategoryKind" NOT NULL DEFAULT 'REGULAR',
    "applies_to" "FeeAppliesTo" NOT NULL DEFAULT 'ALL',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_installment" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "name_key" VARCHAR(60) NOT NULL,
    "due_on" DATE NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_installment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_structure" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_structure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_structure_item" (
    "id" TEXT NOT NULL,
    "structure_id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "installment_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "fee_structure_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_concession" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "kind" "FeeConcessionKind" NOT NULL DEFAULT 'CONCESSION',
    "calc" "FeeCalc" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_concession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_concession_category" (
    "concession_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "fee_concession_category_pkey" PRIMARY KEY ("concession_id","category_id")
);

-- CreateTable
CREATE TABLE "student_concession" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "concession_id" TEXT NOT NULL,
    "status" "StudentConcessionStatus" NOT NULL DEFAULT 'PROPOSED',
    "reason" VARCHAR(500) NOT NULL,
    "proposed_by_id" TEXT,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_concession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "late_fee_rule" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "grace_days" INTEGER NOT NULL,
    "calc" "LateFeeCalc" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "cap" DECIMAL(12,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "late_fee_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_fee_charge" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "installment_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" "FeeChargeSource" NOT NULL DEFAULT 'MANUAL',
    "source_ref" VARCHAR(64),
    "note" VARCHAR(200) NOT NULL,
    "created_by_id" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_fee_charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_invoice" (
    "id" TEXT NOT NULL,
    "invoice_no" VARCHAR(40) NOT NULL,
    "student_id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "kind" "FeeInvoiceKind" NOT NULL DEFAULT 'INSTALLMENT',
    "installment_id" TEXT,
    "due_on" DATE NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "concession_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "late_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "paid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "FeeInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issued_by_id" TEXT,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_by_id" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_invoice_item" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "kind" "FeeInvoiceItemKind" NOT NULL,
    "description" VARCHAR(120) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "concession_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "charge_id" TEXT,

    CONSTRAINT "fee_invoice_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_payment" (
    "id" TEXT NOT NULL,
    "receipt_no" VARCHAR(40) NOT NULL,
    "student_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "FeePaymentMethod" NOT NULL,
    "transaction_ref" VARCHAR(40),
    "instrument_date" DATE,
    "bank_name" VARCHAR(80),
    "paid_on" DATE NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "collected_by_id" TEXT,
    "receipt_snapshot" JSONB NOT NULL,
    "status" "FeePaymentStatus" NOT NULL DEFAULT 'SUCCESS',
    "cancelled_by_id" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_payment_allocation" (
    "payment_id" TEXT NOT NULL,
    "invoice_item_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reversed_at" TIMESTAMPTZ(3),

    CONSTRAINT "fee_payment_allocation_pkey" PRIMARY KEY ("payment_id","invoice_item_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_category_code_key" ON "fee_category"("code");

-- CreateIndex
CREATE UNIQUE INDEX "fee_category_name_key_key" ON "fee_category"("name_key");

-- CreateIndex
CREATE INDEX "fee_installment_academic_session_id_due_on_idx" ON "fee_installment"("academic_session_id", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "fee_installment_academic_session_id_name_key_key" ON "fee_installment"("academic_session_id", "name_key");

-- CreateIndex
CREATE UNIQUE INDEX "fee_installment_id_academic_session_id_key" ON "fee_installment"("id", "academic_session_id");

-- CreateIndex
CREATE INDEX "fee_structure_academic_session_id_class_id_idx" ON "fee_structure"("academic_session_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_structure_id_academic_session_id_key" ON "fee_structure"("id", "academic_session_id");

-- CreateIndex
CREATE INDEX "fee_structure_item_installment_id_idx" ON "fee_structure_item"("installment_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_structure_item_structure_id_category_id_installment_id_key" ON "fee_structure_item"("structure_id", "category_id", "installment_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_concession_code_key" ON "fee_concession"("code");

-- CreateIndex
CREATE UNIQUE INDEX "fee_concession_name_key_key" ON "fee_concession"("name_key");

-- CreateIndex
CREATE INDEX "fee_concession_category_category_id_idx" ON "fee_concession_category"("category_id");

-- CreateIndex
CREATE INDEX "student_concession_student_id_academic_session_id_idx" ON "student_concession"("student_id", "academic_session_id");

-- CreateIndex
CREATE INDEX "student_concession_status_idx" ON "student_concession"("status");

-- CreateIndex
CREATE INDEX "late_fee_rule_academic_session_id_idx" ON "late_fee_rule"("academic_session_id");

-- CreateIndex
CREATE INDEX "student_fee_charge_student_id_academic_session_id_installme_idx" ON "student_fee_charge"("student_id", "academic_session_id", "installment_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_invoice_invoice_no_key" ON "fee_invoice"("invoice_no");

-- CreateIndex
CREATE INDEX "fee_invoice_student_id_status_idx" ON "fee_invoice"("student_id", "status");

-- CreateIndex
CREATE INDEX "fee_invoice_academic_session_id_installment_id_idx" ON "fee_invoice"("academic_session_id", "installment_id");

-- CreateIndex
CREATE INDEX "fee_invoice_status_due_on_idx" ON "fee_invoice"("status", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "fee_invoice_id_student_id_key" ON "fee_invoice"("id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_invoice_item_charge_id_key" ON "fee_invoice_item"("charge_id");

-- CreateIndex
CREATE INDEX "fee_invoice_item_invoice_id_idx" ON "fee_invoice_item"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_invoice_item_id_invoice_id_key" ON "fee_invoice_item"("id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payment_receipt_no_key" ON "fee_payment"("receipt_no");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payment_idempotency_key_key" ON "fee_payment"("idempotency_key");

-- CreateIndex
CREATE INDEX "fee_payment_student_id_paid_on_idx" ON "fee_payment"("student_id", "paid_on");

-- CreateIndex
CREATE INDEX "fee_payment_paid_on_method_idx" ON "fee_payment"("paid_on", "method");

-- CreateIndex
CREATE INDEX "fee_payment_collected_by_id_paid_on_idx" ON "fee_payment"("collected_by_id", "paid_on");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payment_id_student_id_key" ON "fee_payment"("id", "student_id");

-- CreateIndex
CREATE INDEX "fee_payment_allocation_invoice_item_id_idx" ON "fee_payment_allocation"("invoice_item_id");

-- CreateIndex
CREATE INDEX "fee_payment_allocation_invoice_id_idx" ON "fee_payment_allocation"("invoice_id");

-- AddForeignKey
ALTER TABLE "fee_installment" ADD CONSTRAINT "fee_installment_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure" ADD CONSTRAINT "fee_structure_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure" ADD CONSTRAINT "fee_structure_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "school_class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_item" ADD CONSTRAINT "fee_structure_item_structure_id_academic_session_id_fkey" FOREIGN KEY ("structure_id", "academic_session_id") REFERENCES "fee_structure"("id", "academic_session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_item" ADD CONSTRAINT "fee_structure_item_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "fee_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_item" ADD CONSTRAINT "fee_structure_item_installment_id_academic_session_id_fkey" FOREIGN KEY ("installment_id", "academic_session_id") REFERENCES "fee_installment"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concession_category" ADD CONSTRAINT "fee_concession_category_concession_id_fkey" FOREIGN KEY ("concession_id") REFERENCES "fee_concession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concession_category" ADD CONSTRAINT "fee_concession_category_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "fee_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_concession" ADD CONSTRAINT "student_concession_student_id_academic_session_id_fkey" FOREIGN KEY ("student_id", "academic_session_id") REFERENCES "student_enrollment"("student_id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_concession" ADD CONSTRAINT "student_concession_concession_id_fkey" FOREIGN KEY ("concession_id") REFERENCES "fee_concession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_concession" ADD CONSTRAINT "student_concession_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_concession" ADD CONSTRAINT "student_concession_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "late_fee_rule" ADD CONSTRAINT "late_fee_rule_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_charge" ADD CONSTRAINT "student_fee_charge_student_id_academic_session_id_fkey" FOREIGN KEY ("student_id", "academic_session_id") REFERENCES "student_enrollment"("student_id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_charge" ADD CONSTRAINT "student_fee_charge_installment_id_academic_session_id_fkey" FOREIGN KEY ("installment_id", "academic_session_id") REFERENCES "fee_installment"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_charge" ADD CONSTRAINT "student_fee_charge_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "fee_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_charge" ADD CONSTRAINT "student_fee_charge_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice" ADD CONSTRAINT "fee_invoice_student_id_academic_session_id_fkey" FOREIGN KEY ("student_id", "academic_session_id") REFERENCES "student_enrollment"("student_id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice" ADD CONSTRAINT "fee_invoice_installment_id_academic_session_id_fkey" FOREIGN KEY ("installment_id", "academic_session_id") REFERENCES "fee_installment"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice" ADD CONSTRAINT "fee_invoice_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice" ADD CONSTRAINT "fee_invoice_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice_item" ADD CONSTRAINT "fee_invoice_item_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "fee_invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice_item" ADD CONSTRAINT "fee_invoice_item_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "fee_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice_item" ADD CONSTRAINT "fee_invoice_item_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "student_fee_charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment" ADD CONSTRAINT "fee_payment_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment" ADD CONSTRAINT "fee_payment_collected_by_id_fkey" FOREIGN KEY ("collected_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment" ADD CONSTRAINT "fee_payment_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_allocation" ADD CONSTRAINT "fee_payment_allocation_payment_id_student_id_fkey" FOREIGN KEY ("payment_id", "student_id") REFERENCES "fee_payment"("id", "student_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_allocation" ADD CONSTRAINT "fee_payment_allocation_invoice_item_id_invoice_id_fkey" FOREIGN KEY ("invoice_item_id", "invoice_id") REFERENCES "fee_invoice_item"("id", "invoice_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_allocation" ADD CONSTRAINT "fee_payment_allocation_invoice_id_student_id_fkey" FOREIGN KEY ("invoice_id", "student_id") REFERENCES "fee_invoice"("id", "student_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────────── Hand-written: partial unique indexes ─────────────────────────────
-- FC3 / FC5: at most one ACTIVE fee structure per (session, class); old versions stay for issued invoices.
CREATE UNIQUE INDEX "fee_structure_active_key" ON "fee_structure" ("academic_session_id", "class_id") WHERE "is_active";
-- FC7: at most one active late-fee rule per session.
CREATE UNIQUE INDEX "late_fee_rule_active_key" ON "late_fee_rule" ("academic_session_id") WHERE "is_active";
-- FC6: one open (PROPOSED) or APPROVED use of a concession per enrollment; rejected / revoked rows are history.
CREATE UNIQUE INDEX "student_concession_live_key" ON "student_concession" ("student_id", "academic_session_id", "concession_id") WHERE "status" IN ('PROPOSED', 'APPROVED');
-- FC5: re-running generation can't bill an installment twice; a cancelled invoice (deleted_at set) can be re-issued.
CREATE UNIQUE INDEX "fee_invoice_live_installment_key" ON "fee_invoice" ("student_id", "academic_session_id", "installment_id") WHERE "deleted_at" IS NULL AND "kind" = 'INSTALLMENT';
-- FC19: one live opening-balance invoice per enrollment (the import is idempotent by student).
CREATE UNIQUE INDEX "fee_invoice_live_opening_key" ON "fee_invoice" ("student_id", "academic_session_id") WHERE "deleted_at" IS NULL AND "kind" = 'OPENING_BALANCE';
-- FC10 (review 5A M4): a reference is used once among SUCCESSFUL payments; a cancelled (e.g. dishonoured) payment
-- frees it. UPI and bank transfers share one space (both carry the bank's UTR — one credit can't become two receipts);
-- cheque numbers repeat across banks, so a cheque is unique by number + bank + cheque date; card slips per method.
CREATE UNIQUE INDEX "fee_payment_live_utr_key" ON "fee_payment" ("transaction_ref") WHERE "method" IN ('UPI', 'BANK_TRANSFER') AND "status" = 'SUCCESS';
CREATE UNIQUE INDEX "fee_payment_live_cheque_key" ON "fee_payment" ("transaction_ref", "bank_name", "instrument_date") WHERE "method" = 'CHEQUE' AND "status" = 'SUCCESS';
CREATE UNIQUE INDEX "fee_payment_live_card_key" ON "fee_payment" ("transaction_ref") WHERE "method" = 'CARD' AND "status" = 'SUCCESS';
-- FC18: the Phase 7 transport sync writes each (enrollment, installment, source) charge once.
CREATE UNIQUE INDEX "student_fee_charge_live_source_key" ON "student_fee_charge" ("student_id", "academic_session_id", "installment_id", "source_ref") WHERE "source" = 'TRANSPORT' AND "deleted_at" IS NULL;

-- ───────────────────────────── Hand-written: CHECK constraints ─────────────────────────────
ALTER TABLE "fee_category"
  ADD CONSTRAINT "fee_category_code_format" CHECK ("code" ~ '^[A-Z0-9_-]{2,20}$'),
  ADD CONSTRAINT "fee_category_name_trimmed" CHECK ("name" = btrim("name") AND "name" <> ''),
  ADD CONSTRAINT "fee_category_version_positive" CHECK ("version" >= 1);

ALTER TABLE "fee_installment"
  ADD CONSTRAINT "fee_installment_name_trimmed" CHECK ("name" = btrim("name") AND "name" <> ''),
  ADD CONSTRAINT "fee_installment_version_positive" CHECK ("version" >= 1);

ALTER TABLE "fee_structure"
  ADD CONSTRAINT "fee_structure_name_trimmed" CHECK ("name" = btrim("name") AND "name" <> ''),
  ADD CONSTRAINT "fee_structure_version_positive" CHECK ("version" >= 1);

ALTER TABLE "fee_structure_item"
  ADD CONSTRAINT "fee_structure_item_amount_non_negative" CHECK ("amount" >= 0);

ALTER TABLE "fee_concession"
  ADD CONSTRAINT "fee_concession_code_format" CHECK ("code" ~ '^[A-Z0-9_-]{2,20}$'),
  ADD CONSTRAINT "fee_concession_value_range" CHECK ("value" > 0 AND ("calc" <> 'PERCENT' OR "value" <= 100)),
  ADD CONSTRAINT "fee_concession_version_positive" CHECK ("version" >= 1);

-- FC6: decided ⇔ not PROPOSED (the decider may later be SET NULL; the time stays).
ALTER TABLE "student_concession"
  ADD CONSTRAINT "student_concession_decided" CHECK (("status" = 'PROPOSED') = ("decided_at" IS NULL)),
  ADD CONSTRAINT "student_concession_reason" CHECK (length(btrim("reason")) >= 3),
  -- Review 5A L5: maker-checker in the database too, whenever both people are still known.
  ADD CONSTRAINT "student_concession_two_people" CHECK ("decided_by_id" IS NULL OR "proposed_by_id" IS NULL OR "decided_by_id" <> "proposed_by_id"),
  ADD CONSTRAINT "student_concession_version_positive" CHECK ("version" >= 1);

ALTER TABLE "late_fee_rule"
  ADD CONSTRAINT "late_fee_rule_grace" CHECK ("grace_days" BETWEEN 0 AND 365),
  ADD CONSTRAINT "late_fee_rule_value" CHECK ("value" > 0 AND ("calc" <> 'PERCENT' OR "value" <= 100)),
  ADD CONSTRAINT "late_fee_rule_cap" CHECK ("cap" IS NULL OR "cap" > 0),
  -- Review 5A L3: a per-day fee must have a ceiling.
  ADD CONSTRAINT "late_fee_rule_per_day_cap" CHECK ("calc" <> 'PER_DAY' OR "cap" IS NOT NULL),
  ADD CONSTRAINT "late_fee_rule_version_positive" CHECK ("version" >= 1);

ALTER TABLE "student_fee_charge"
  ADD CONSTRAINT "student_fee_charge_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "student_fee_charge_note_trimmed" CHECK ("note" = btrim("note") AND "note" <> ''),
  ADD CONSTRAINT "student_fee_charge_transport_ref" CHECK ("source" <> 'TRANSPORT' OR "source_ref" IS NOT NULL),
  ADD CONSTRAINT "student_fee_charge_version_positive" CHECK ("version" >= 1);

-- Invoice arithmetic and status are enforced in the database too (the service is not the only guard).
ALTER TABLE "fee_invoice"
  ADD CONSTRAINT "fee_invoice_amounts_non_negative" CHECK ("subtotal" >= 0 AND "concession_total" >= 0 AND "late_fee" >= 0 AND "paid_amount" >= 0),
  ADD CONSTRAINT "fee_invoice_concession_le_subtotal" CHECK ("concession_total" <= "subtotal"),
  ADD CONSTRAINT "fee_invoice_total" CHECK ("total" = "subtotal" - "concession_total" + "late_fee"),
  ADD CONSTRAINT "fee_invoice_paid_le_total" CHECK ("paid_amount" <= "total"),
  ADD CONSTRAINT "fee_invoice_kind_installment" CHECK (("kind" = 'INSTALLMENT') = ("installment_id" IS NOT NULL)),
  -- Cancelled ⇔ soft-deleted, with who / when / why; only an unpaid invoice can be cancelled (FC5).
  ADD CONSTRAINT "fee_invoice_cancelled" CHECK (("status" = 'CANCELLED') = ("deleted_at" IS NOT NULL)),
  ADD CONSTRAINT "fee_invoice_cancel_fields" CHECK ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL AND "paid_amount" = 0)),
  ADD CONSTRAINT "fee_invoice_status_amounts" CHECK (
    ("status" = 'ISSUED' AND "paid_amount" = 0 AND "total" > 0) OR
    ("status" = 'PARTIAL' AND "paid_amount" > 0 AND "paid_amount" < "total") OR
    ("status" = 'PAID' AND "paid_amount" = "total" AND "total" > 0) OR
    ("status" = 'WAIVED' AND "paid_amount" = "total") OR
    ("status" = 'CANCELLED')
  ),
  ADD CONSTRAINT "fee_invoice_version_positive" CHECK ("version" >= 1);

ALTER TABLE "fee_invoice_item"
  ADD CONSTRAINT "fee_invoice_item_amount_non_negative" CHECK ("amount" >= 0),
  ADD CONSTRAINT "fee_invoice_item_concession_range" CHECK ("concession_amount" >= 0 AND "concession_amount" <= "amount"),
  ADD CONSTRAINT "fee_invoice_item_paid_range" CHECK ("paid_amount" >= 0 AND "paid_amount" <= "amount" - "concession_amount"),
  ADD CONSTRAINT "fee_invoice_item_charge" CHECK (("kind" = 'CHARGE') = ("charge_id" IS NOT NULL)),
  ADD CONSTRAINT "fee_invoice_item_description_trimmed" CHECK ("description" = btrim("description") AND "description" <> '');

-- FC10 / FC13: cash has no reference, every other method has a normalized one; cancelled ⇔ who / when / why.
ALTER TABLE "fee_payment"
  ADD CONSTRAINT "fee_payment_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "fee_payment_reference" CHECK (("method" = 'CASH') = ("transaction_ref" IS NULL)),
  -- Review 5A L6: starts with a letter or digit (never a spreadsheet formula character).
  ADD CONSTRAINT "fee_payment_reference_format" CHECK ("transaction_ref" IS NULL OR "transaction_ref" ~ '^[A-Z0-9][A-Z0-9/_.-]{3,39}$'),
  -- Review 5A M4: a cheque names its bank (normalized upper case, trimmed) and its date.
  ADD CONSTRAINT "fee_payment_cheque_details" CHECK ("method" <> 'CHEQUE' OR ("bank_name" IS NOT NULL AND "instrument_date" IS NOT NULL)),
  ADD CONSTRAINT "fee_payment_bank_name_normalized" CHECK ("bank_name" IS NULL OR ("bank_name" = upper(btrim("bank_name")) AND "bank_name" <> '')),
  -- Review 5A L5: the canceller is never the collector, whenever both are still known.
  ADD CONSTRAINT "fee_payment_two_people" CHECK ("cancelled_by_id" IS NULL OR "collected_by_id" IS NULL OR "cancelled_by_id" <> "collected_by_id"),
  ADD CONSTRAINT "fee_payment_cancelled" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
  ADD CONSTRAINT "fee_payment_cancel_reason" CHECK ("status" <> 'CANCELLED' OR "cancel_reason" IS NOT NULL),
  ADD CONSTRAINT "fee_payment_print_count" CHECK ("print_count" >= 0),
  ADD CONSTRAINT "fee_payment_idempotency_key" CHECK (length("idempotency_key") BETWEEN 16 AND 64),
  ADD CONSTRAINT "fee_payment_version_positive" CHECK ("version" >= 1);

ALTER TABLE "fee_payment_allocation"
  ADD CONSTRAINT "fee_payment_allocation_amount_positive" CHECK ("amount" > 0);

-- ───────────────────────────── Hand-written: issued receipts can't be rewritten (review 5A M1) ─────────────────────────────
-- Same approach as audit_log (S-07): the database refuses, whatever the caller. A payment row may only be cancelled
-- (once, SUCCESS → CANCELLED, with who / when / why), printed again (print_count only grows), have its version
-- bumped, or lose an actor reference when that user row is deleted (ON DELETE SET NULL). Nothing is ever deleted.
CREATE FUNCTION fee_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fee_payment rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.receipt_no <> OLD.receipt_no OR NEW.student_id <> OLD.student_id OR NEW.amount <> OLD.amount
     OR NEW.method <> OLD.method OR NEW.transaction_ref IS DISTINCT FROM OLD.transaction_ref
     OR NEW.instrument_date IS DISTINCT FROM OLD.instrument_date OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
     OR NEW.paid_on <> OLD.paid_on OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.receipt_snapshot::text <> OLD.receipt_snapshot::text OR NEW.created_at <> OLD.created_at
     OR (NEW.collected_by_id IS DISTINCT FROM OLD.collected_by_id AND NEW.collected_by_id IS NOT NULL) THEN
    RAISE EXCEPTION 'an issued receipt can''t be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.print_count < OLD.print_count THEN
    RAISE EXCEPTION 'print_count only grows' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'CANCELLED' AND (NEW.status <> 'CANCELLED' OR NEW.cancelled_at <> OLD.cancelled_at
     OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
     OR (NEW.cancelled_by_id IS DISTINCT FROM OLD.cancelled_by_id AND NEW.cancelled_by_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'a cancelled receipt stays cancelled' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fee_payment_immutable BEFORE UPDATE OR DELETE ON "fee_payment"
  FOR EACH ROW EXECUTE FUNCTION fee_payment_guard();

-- An allocation is written once; the only later change is marking it reversed (NULL → a time) when its receipt is
-- cancelled. Never deleted.
CREATE FUNCTION fee_payment_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fee_payment_allocation rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.payment_id <> OLD.payment_id OR NEW.invoice_item_id <> OLD.invoice_item_id OR NEW.invoice_id <> OLD.invoice_id
     OR NEW.student_id <> OLD.student_id OR NEW.amount <> OLD.amount
     OR (OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at) THEN
    RAISE EXCEPTION 'an allocation can only be marked reversed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fee_payment_allocation_immutable BEFORE UPDATE OR DELETE ON "fee_payment_allocation"
  FOR EACH ROW EXECUTE FUNCTION fee_payment_allocation_guard();

COMMIT;
