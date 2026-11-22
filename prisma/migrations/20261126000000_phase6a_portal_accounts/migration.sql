-- Phase 6A-M1: portal accounts (PHASE_6_PLAN.md §5 migration A; decisions P2, P4, P15, P23, P24 approved 2026-11-22).
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, 6 CHECKs, the KI-105 backfill.
-- Expand-only: new nullable columns, one NOT NULL column with a constant default (portal_access, no table rewrite on
-- PG 11+), one new table, indexes, foreign keys and CHECKs. Nothing is dropped or renamed.
--   1. user.student_id / user.guardian_id become FKs (RESTRICT) — expected: no rows set yet; an orphan makes the FK
--      fail and the whole transaction roll back. CHECK user_one_person: an account is staff OR one guardian OR one
--      student (ADR-045) — fails (and rolls back) if any existing user already has two links.
--   2. user.privacy_consent_at / _version (DPDP consent at activation) + CHECK both-or-neither.
--   3. student_guardian.portal_access (P24 custody block), default true.
--   4. account_activation (single-use code hashes; ON DELETE CASCADE with the user) + CHECKs.
--   5. KI-105 (P15): fee_invoice_item waiver columns + frozen_by_payment_id, CHECKs, and a BACKFILL of existing waiver
--      lines: "Late fee ₹<amount> waived: <reason>" → waived_amount / waiver_reason, description → "Late fee waived"
--      (the reason leaves the text the ledger shows). fee_invoice_item has no immutability trigger. Existing charged
--      late-fee lines keep frozen_by_payment_id NULL (who froze them was never recorded); the code treats NULL as
--      "unknown" and keeps the Phase 5 rule for them.
--   6. notification.dedupe_key + partial unique (user_id, dedupe_key) + index (user_id, created_at DESC).
-- Review status: SQL approved by the owner 2026-11-22.
--
-- Rollback (comment only — development/Test; the backfill is not reversed: the old text had the same data):
--   ALTER TABLE "notification" DROP COLUMN "dedupe_key";
--   ALTER TABLE "fee_invoice_item" DROP CONSTRAINT "fee_invoice_item_waiver", DROP CONSTRAINT "fee_invoice_item_frozen_kind",
--     DROP COLUMN "frozen_by_payment_id", DROP COLUMN "waived_amount", DROP COLUMN "waived_by_id",
--     DROP COLUMN "waived_with_payment_id", DROP COLUMN "waiver_reason";
--   DROP TABLE "account_activation"; DROP TYPE "ActivationChannel";
--   ALTER TABLE "student_guardian" DROP COLUMN "portal_access";
--   ALTER TABLE "user" DROP CONSTRAINT "user_one_person", DROP CONSTRAINT "user_privacy_consent_pair",
--     DROP CONSTRAINT "user_student_id_fkey", DROP CONSTRAINT "user_guardian_id_fkey",
--     DROP COLUMN "privacy_consent_at", DROP COLUMN "privacy_consent_version";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261126000000_phase6a_portal_accounts';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ActivationChannel" AS ENUM ('SLIP', 'EMAIL');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "privacy_consent_at" TIMESTAMPTZ(3),
ADD COLUMN     "privacy_consent_version" VARCHAR(20);

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "dedupe_key" VARCHAR(120);

-- AlterTable
ALTER TABLE "student_guardian" ADD COLUMN     "portal_access" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "fee_invoice_item" ADD COLUMN     "frozen_by_payment_id" TEXT,
ADD COLUMN     "waived_amount" DECIMAL(12,2),
ADD COLUMN     "waived_by_id" TEXT,
ADD COLUMN     "waived_with_payment_id" TEXT,
ADD COLUMN     "waiver_reason" VARCHAR(500);

-- CreateTable
CREATE TABLE "account_activation" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" VARCHAR(128) NOT NULL,
    "channel" "ActivationChannel" NOT NULL DEFAULT 'SLIP',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "failed_attempts" SMALLINT NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_activation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_activation_code_hash_key" ON "account_activation"("code_hash");

-- CreateIndex
CREATE INDEX "account_activation_user_id_idx" ON "account_activation"("user_id");

-- CreateIndex
CREATE INDEX "account_activation_expires_at_idx" ON "account_activation"("expires_at");

-- CreateIndex
CREATE INDEX "notification_user_id_created_at_idx" ON "notification"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_user_dedupe_key" ON "notification"("user_id", "dedupe_key") WHERE (dedupe_key IS NOT NULL);

-- CreateIndex
CREATE INDEX "fee_invoice_item_waived_with_payment_id_idx" ON "fee_invoice_item"("waived_with_payment_id");

-- CreateIndex
CREATE INDEX "fee_invoice_item_frozen_by_payment_id_idx" ON "fee_invoice_item"("frozen_by_payment_id");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardian"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_activation" ADD CONSTRAINT "account_activation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_activation" ADD CONSTRAINT "account_activation_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice_item" ADD CONSTRAINT "fee_invoice_item_waived_by_id_fkey" FOREIGN KEY ("waived_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice_item" ADD CONSTRAINT "fee_invoice_item_waived_with_payment_id_fkey" FOREIGN KEY ("waived_with_payment_id") REFERENCES "fee_payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice_item" ADD CONSTRAINT "fee_invoice_item_frozen_by_payment_id_fkey" FOREIGN KEY ("frozen_by_payment_id") REFERENCES "fee_payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: an account belongs to at most one person record (staff, one guardian or one student — ADR-045).
ALTER TABLE "user"
  ADD CONSTRAINT "user_one_person" CHECK (num_nonnulls("employee_id", "student_id", "guardian_id") <= 1),
  ADD CONSTRAINT "user_privacy_consent_pair" CHECK (("privacy_consent_at" IS NULL) = ("privacy_consent_version" IS NULL));

-- Hand-written: activation codes expire after they are made and count failures from zero.
ALTER TABLE "account_activation"
  ADD CONSTRAINT "account_activation_expiry" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "account_activation_failed_attempts" CHECK ("failed_attempts" >= 0);

-- KI-105 backfill (before the CHECKs): existing waiver lines move amount and reason out of the shown text.
UPDATE "fee_invoice_item"
SET "waived_amount" = substring("description" from '^Late fee ₹([0-9]+(\.[0-9]{1,2})?) waived:')::numeric(12,2),
    "waiver_reason" = coalesce(nullif(btrim(substring("description" from 'waived:(.*)$')), ''), '(not recorded)'),
    "description" = 'Late fee waived'
WHERE "kind" = 'LATE_FEE' AND "amount" = 0 AND "description" ~ '^Late fee ₹[0-9]+(\.[0-9]{1,2})? waived:';

-- Hand-written: waiver data only on a zero LATE_FEE line, and then complete; a freezing payment only on LATE_FEE lines.
ALTER TABLE "fee_invoice_item"
  ADD CONSTRAINT "fee_invoice_item_waiver" CHECK (
    ("waived_amount" IS NULL AND "waiver_reason" IS NULL AND "waived_by_id" IS NULL AND "waived_with_payment_id" IS NULL) OR
    ("kind" = 'LATE_FEE' AND "amount" = 0 AND "waived_amount" > 0 AND "waiver_reason" IS NOT NULL AND "waiver_reason" <> '')
  ),
  ADD CONSTRAINT "fee_invoice_item_frozen_kind" CHECK ("frozen_by_payment_id" IS NULL OR "kind" = 'LATE_FEE');

COMMIT;
