-- Phase 5A-M4: record which fee structure each installment invoice was made from (KI-103; security review 5A-M2 M1),
-- so exactly the invoiced structures are frozen.
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, one CHECK.
-- Expand-only on a table that is still EMPTY on development and Test (invoice generation ships with this change): a
-- nullable column, an index, a composite foreign key (structure + session, RESTRICT) and a CHECK. Nothing is dropped.
-- If fee_invoice ever had rows without a structure, the CHECK would fail and the whole transaction would roll back.
-- Review status: SQL approved by the owner 2026-11-20.
--
-- Rollback (comment only — development/Test, only while fee_invoice is empty):
--   ALTER TABLE "fee_invoice" DROP CONSTRAINT "fee_invoice_structure_kind", DROP CONSTRAINT "fee_invoice_structure_id_academic_session_id_fkey";
--   DROP INDEX "fee_invoice_structure_id_idx"; ALTER TABLE "fee_invoice" DROP COLUMN "structure_id";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261125000000_phase5a_invoice_structure';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "fee_invoice" ADD COLUMN     "structure_id" TEXT;

-- CreateIndex
CREATE INDEX "fee_invoice_structure_id_idx" ON "fee_invoice"("structure_id");

-- AddForeignKey: the structure must belong to the invoice's own session.
ALTER TABLE "fee_invoice" ADD CONSTRAINT "fee_invoice_structure_id_academic_session_id_fkey" FOREIGN KEY ("structure_id", "academic_session_id") REFERENCES "fee_structure"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: an installment invoice always names its structure; an opening-balance invoice never does.
ALTER TABLE "fee_invoice"
  ADD CONSTRAINT "fee_invoice_structure_kind" CHECK (("kind" = 'INSTALLMENT') = ("structure_id" IS NOT NULL));

COMMIT;
