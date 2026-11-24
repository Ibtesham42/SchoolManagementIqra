-- Phase 6C-M3: parent payment claims — UPI / bank-transfer intimation (PHASE_6_PLAN.md §5 migration C; P19 approved
-- 2026-11-22; ADR-048). Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema
-- prisma/schema.prisma --script` (no database touched), then hand-edited: one transaction, lock_timeout, 7 CHECKs.
-- Expand-only: two enums, one new table, its indexes, foreign keys and CHECKs. No existing table changes (only new FKs
-- pointing at student, fee_payment and user). No backfill.
--   fee_payment_claim — a parent's "I paid" with the canonical transaction reference. It never marks anything paid by
--   itself: an Accountant confirms it (an ordinary receipt through the counter path; payment_id set, unique) or rejects
--   it with a reason. Partial unique (transaction_ref) WHERE status IN (SUBMITTED, CONFIRMED): a reference has at most one
--   live claim; a rejected claim frees it. (Live receipts keep their own unique index, fee_payment_live_utr_key.)
-- Review status: SQL approved by the owner 2026-11-24. Not applied anywhere yet (development, then Test, with approval).
--
-- Rollback (comment only — development/Test; the table is new, so nothing else is lost):
--   DROP TABLE "fee_payment_claim"; DROP TYPE "FeeClaimStatus"; DROP TYPE "FeeClaimMethod";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261128000000_phase6c_payment_claims';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';
-- CreateEnum
CREATE TYPE "FeeClaimMethod" AS ENUM ('UPI', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "FeeClaimStatus" AS ENUM ('SUBMITTED', 'CONFIRMED', 'REJECTED');

-- CreateTable
CREATE TABLE "fee_payment_claim" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "FeeClaimMethod" NOT NULL,
    "transaction_ref" VARCHAR(40) NOT NULL,
    "paid_on" DATE NOT NULL,
    "status" "FeeClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submitted_by_id" TEXT,
    "payment_id" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(300),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_payment_claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_payment_claim_payment_id_key" ON "fee_payment_claim"("payment_id");

-- CreateIndex
CREATE INDEX "fee_payment_claim_status_created_at_idx" ON "fee_payment_claim"("status", "created_at");

-- CreateIndex
CREATE INDEX "fee_payment_claim_student_id_created_at_idx" ON "fee_payment_claim"("student_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payment_claim_live_ref_key" ON "fee_payment_claim"("transaction_ref") WHERE (status = ANY (ARRAY['SUBMITTED'::"FeeClaimStatus", 'CONFIRMED'::"FeeClaimStatus"]));

-- AddForeignKey
ALTER TABLE "fee_payment_claim" ADD CONSTRAINT "fee_payment_claim_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_claim" ADD CONSTRAINT "fee_payment_claim_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "fee_payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_claim" ADD CONSTRAINT "fee_payment_claim_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_claim" ADD CONSTRAINT "fee_payment_claim_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written: a claim is for a positive amount with a reference; CONFIRMED exactly when it carries its receipt;
-- REJECTED exactly when it has a (non-blank) reason; decided exactly when it left SUBMITTED; the person who submitted it
-- never decides it; version counts from 1.
ALTER TABLE "fee_payment_claim"
  ADD CONSTRAINT "fee_payment_claim_amount" CHECK ("amount" > 0),
  ADD CONSTRAINT "fee_payment_claim_ref" CHECK (btrim("transaction_ref") <> ''),
  ADD CONSTRAINT "fee_payment_claim_confirmed" CHECK (("status" = 'CONFIRMED') = ("payment_id" IS NOT NULL)),
  ADD CONSTRAINT "fee_payment_claim_rejected" CHECK (("status" = 'REJECTED') = ("reject_reason" IS NOT NULL) AND ("reject_reason" IS NULL OR btrim("reject_reason") <> '')),
  ADD CONSTRAINT "fee_payment_claim_decided" CHECK (("status" = 'SUBMITTED') = ("decided_at" IS NULL)),
  ADD CONSTRAINT "fee_payment_claim_decider" CHECK ("decided_by_id" IS NULL OR "submitted_by_id" IS NULL OR "decided_by_id" <> "submitted_by_id"),
  ADD CONSTRAINT "fee_payment_claim_version" CHECK ("version" >= 1);

COMMIT;
