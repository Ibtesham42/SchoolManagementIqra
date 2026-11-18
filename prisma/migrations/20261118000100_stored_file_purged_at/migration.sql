-- S-15 (SECURITY_AUDIT_2026-11-10_PHASE_2B.md Appendix A; owner decision 2026-11-18: 30-day grace period,
-- purged_at, first run of the purge job as a dry run). Adds stored_file.purged_at: set by the purge job after it
-- deleted the encrypted blob of a RETIRED file (deleted_at + 30 days). The metadata row is kept (id, purpose,
-- owner, size, sha256 — no content) so audit trails stay resolvable.
-- Generated offline by `prisma migrate diff --from-schema <previous> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, the CHECK.
-- Expand-only: one nullable column (metadata-only ALTER, no table rewrite) + one CHECK that every existing row
-- satisfies (purged_at is NULL everywhere). The previous release keeps working (it never reads the column).
-- Review status: CREATED FOR REVIEW 2026-11-18 — NOT APPLIED. Applying to development / Test needs the owner's
-- separate approval per branch; never production without explicit approval.
--
-- Rollback (comment only — owner-approved, development/Test only, and only while no row has purged_at set):
--   ALTER TABLE "stored_file" DROP CONSTRAINT "stored_file_purged_check";
--   ALTER TABLE "stored_file" DROP COLUMN "purged_at";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118000100_stored_file_purged_at';

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "stored_file" ADD COLUMN     "purged_at" TIMESTAMPTZ(3);

-- A file can only be purged after it was retired, and never before it was retired.
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_purged_check"
  CHECK ("purged_at" IS NULL OR ("deleted_at" IS NOT NULL AND "purged_at" >= "deleted_at"));

COMMIT;
