-- Phase 6C-M4: a "parents only" notice audience (owner decision 2026-11-24 on review 6C-M1 L4: student accounts must
-- not see notices written for parents, e.g. fees or discipline). Generated offline by `prisma migrate diff` (the
-- ALTER TYPE), then hand-edited: one transaction, lock_timeout, the staff-scope CHECK rewritten.
-- Expand-only: one enum value added; one CHECK replaced by an equivalent one that also admits PARENTS at any scope.
--   The new CHECK avoids naming the new value ('PARENTS' can't be used in the transaction that adds it); it says the
--   same thing as before for the existing values: STAFF / ALL notices are school-wide only.
-- Depends on migration 20261127000000_phase6c_notices (applied before this one, in order).
-- Review status: SQL approved by the owner 2026-11-24. Not applied anywhere yet (after B and C; development, then Test, with approval).
--
-- Rollback (comment only — development/Test, only while no notice uses PARENTS): PostgreSQL can't drop an enum value;
--   restore the CHECK with: ALTER TABLE "notice" DROP CONSTRAINT "notice_staff_school_wide",
--     ADD CONSTRAINT "notice_staff_school_wide" CHECK ("audience" = 'FAMILIES' OR "scope" = 'SCHOOL');
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261129000000_phase6c_notice_parents';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "NoticeAudience" ADD VALUE 'PARENTS';

-- Hand-written: STAFF / ALL stay school-wide only; FAMILIES and PARENTS may target classes or sections.
ALTER TABLE "notice"
  DROP CONSTRAINT "notice_staff_school_wide",
  ADD CONSTRAINT "notice_staff_school_wide" CHECK ("audience" NOT IN ('STAFF', 'ALL') OR "scope" = 'SCHOOL');

COMMIT;
