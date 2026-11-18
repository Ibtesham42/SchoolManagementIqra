-- Phase 2a: file purpose/ownership, regional settings, logo foreign key, generated-document registry.
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma`
-- (no database available), then hand-edited so it is safe on tables that already contain rows:
--   * pre-flight guards abort before anything changes if existing data can't satisfy the new rules;
--   * stored_file.purpose is added nullable, backfilled, then made NOT NULL;
--   * files that predate purposes get the sentinel owner ('LegacyFile', <own id>) — Super Admin only;
--   * dangling school_setting.logo_file_id values are cleared before the foreign key is added;
--   * CHECK constraints (not modelled by Prisma), all fully validated.
-- Expand-only: no column/table is dropped or renamed, so the previous release keeps working.
-- Single-school installation (ADR-030): no school_id columns.
-- Review status: AWAITING OWNER APPROVAL — do not apply.

-- All-or-nothing: any failure (including the guards) leaves the database exactly as it was.
BEGIN;

-- ─── 0. Pre-flight guards (read-only) ───────────────────────────────────────────
-- Stop rather than silently skip: an unencrypted PRIVATE file must be re-encrypted or reviewed by a
-- person first, and an id longer than 64 characters wouldn't fit owner_id VARCHAR(64) — both
-- stored_file ids (backfill 2) and school_setting ids (backfill 1) are copied there. Both id columns
-- are unbounded TEXT; the app only ever writes cuid2 (24 chars) and 'default', so these never fire
-- on data the app created.
DO $$
DECLARE
  unencrypted integer;
  long_ids integer;
  long_setting_ids integer;
BEGIN
  SELECT count(*) INTO unencrypted FROM "stored_file"
  WHERE "visibility" = 'PRIVATE' AND ("encrypted" = false OR "key_version" IS NULL);
  IF unencrypted > 0 THEN
    RAISE EXCEPTION 'Migration 20261109000000 aborted: % PRIVATE stored_file row(s) are not encrypted with a key version. Encrypt or review them first; nothing was changed.', unencrypted;
  END IF;

  SELECT count(*) INTO long_ids FROM "stored_file" WHERE length("id") > 64;
  IF long_ids > 0 THEN
    RAISE EXCEPTION 'Migration 20261109000000 aborted: % stored_file id(s) are longer than 64 characters; nothing was changed.', long_ids;
  END IF;

  SELECT count(*) INTO long_setting_ids FROM "school_setting" WHERE "logo_file_id" IS NOT NULL AND length("id") > 64;
  IF long_setting_ids > 0 THEN
    RAISE EXCEPTION 'Migration 20261109000000 aborted: % school_setting id(s) referencing a logo are longer than 64 characters; nothing was changed.', long_setting_ids;
  END IF;
END $$;

-- ─── 1. Generated documents: enum ───────────────────────────────────────────────
-- CreateEnum
CREATE TYPE "GeneratedDocumentType" AS ENUM ('ID_CARD', 'CERTIFICATE', 'RECEIPT', 'REPORT_CARD', 'SALARY_SLIP', 'OTHER');

-- ─── 2. School settings: regional fields + created_at ───────────────────────────
-- Constant defaults: Postgres 11+ adds these without rewriting the table; existing rows get the default.
-- created_at for the existing row becomes the migration time (its true creation time was never recorded).
-- AlterTable
ALTER TABLE "school_setting" ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
ADD COLUMN     "date_format" VARCHAR(16) NOT NULL DEFAULT 'DD/MM/YYYY',
ADD COLUMN     "locale" VARCHAR(16) NOT NULL DEFAULT 'en-IN';

-- ─── 3. Stored files: purpose + owner ───────────────────────────────────────────
-- AlterTable (purpose nullable first; made NOT NULL after the backfill below)
ALTER TABLE "stored_file" ADD COLUMN     "owner_id" VARCHAR(64),
ADD COLUMN     "owner_type" VARCHAR(40),
ADD COLUMN     "purpose" VARCHAR(40);

-- Backfill 1: the current school logo is the only purpose that existed before this migration.
UPDATE "stored_file" AS f
SET "purpose" = 'school.logo', "owner_type" = 'SchoolSetting', "owner_id" = s."id"
FROM "school_setting" AS s
WHERE s."logo_file_id" = f."id";

-- Backfill 2: every other existing file predates purposes. It keeps its blob, visibility and
-- encryption, and is filed under its own id as a 'LegacyFile'. The application treats the
-- 'unclassified' purpose as Super Admin–only regardless of visibility (files.service canReadStoredFile).
UPDATE "stored_file"
SET "purpose" = 'unclassified', "owner_type" = 'LegacyFile', "owner_id" = "id"
WHERE "purpose" IS NULL;

ALTER TABLE "stored_file" ALTER COLUMN "purpose" SET NOT NULL;

-- Owner columns are set together or not at all.
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_owner_pair"
  CHECK (("owner_type" IS NULL) = ("owner_id" IS NULL));

-- PRIVATE files must name their owning record, so access can follow that record's policy.
-- Fully validated: after backfill 2 every existing row satisfies it.
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_private_has_owner"
  CHECK ("visibility" = 'PUBLIC' OR ("owner_type" IS NOT NULL AND "owner_id" IS NOT NULL));

-- PRIVATE files are always encrypted by the app and record the key version needed to decrypt them.
-- Fully validated: guard 0 has already proved every existing row satisfies it.
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_private_encrypted"
  CHECK ("visibility" = 'PUBLIC' OR ("encrypted" = true AND "key_version" IS NOT NULL));

-- CreateIndex
CREATE INDEX "stored_file_owner_type_owner_id_idx" ON "stored_file"("owner_type", "owner_id");

-- ─── 4. Generated documents: table ──────────────────────────────────────────────
-- CreateTable
CREATE TABLE "generated_document" (
    "id" TEXT NOT NULL,
    "type" "GeneratedDocumentType" NOT NULL,
    "verification_code_hash" CHAR(64) NOT NULL,
    "verification_key_version" SMALLINT NOT NULL,
    "subject_type" VARCHAR(40) NOT NULL,
    "subject_id" VARCHAR(64) NOT NULL,
    "file_id" TEXT,
    "generated_by_id" TEXT,
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" TEXT,
    "revocation_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "generated_document_pkey" PRIMARY KEY ("id"),
    -- Only an HMAC-SHA256 hex digest can be stored here — never a raw verification code.
    CONSTRAINT "generated_document_code_hash_format" CHECK ("verification_code_hash" ~ '^[0-9a-f]{64}$'),
    -- DOCUMENT_VERIFICATION_KEY versions start at 1 (no default: the app must always say which key it used).
    CONSTRAINT "generated_document_key_version_positive" CHECK ("verification_key_version" >= 1),
    -- Revoker and reason only make sense on a revoked document (revoked_by_id may later become NULL
    -- via ON DELETE SET NULL, so it is not required when revoked_at is set).
    CONSTRAINT "generated_document_revocation_consistent" CHECK ("revoked_at" IS NOT NULL OR ("revoked_by_id" IS NULL AND "revocation_reason" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "generated_document_verification_code_hash_key" ON "generated_document"("verification_code_hash");

-- CreateIndex (unique: one registry entry per PDF; also serves as the FK index)
CREATE UNIQUE INDEX "generated_document_file_id_key" ON "generated_document"("file_id");

-- CreateIndex
CREATE INDEX "generated_document_subject_type_subject_id_idx" ON "generated_document"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "generated_document_type_generated_at_idx" ON "generated_document"("type", "generated_at");

-- ─── 5. Foreign keys ────────────────────────────────────────────────────────────
-- A logo id that points at no file would make the new foreign key fail; clear it (the school simply has no logo).
UPDATE "school_setting" SET "logo_file_id" = NULL
WHERE "logo_file_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "stored_file" f WHERE f."id" = "school_setting"."logo_file_id");

-- AddForeignKey (deleting a file row clears the logo instead of failing; normal removal is a soft delete)
ALTER TABLE "school_setting" ADD CONSTRAINT "school_setting_logo_file_id_fkey" FOREIGN KEY ("logo_file_id") REFERENCES "stored_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (RESTRICT: an issued document's PDF can't be hard-deleted while it is registered)
ALTER TABLE "generated_document" ADD CONSTRAINT "generated_document_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_document" ADD CONSTRAINT "generated_document_generated_by_id_fkey" FOREIGN KEY ("generated_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_document" ADD CONSTRAINT "generated_document_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
