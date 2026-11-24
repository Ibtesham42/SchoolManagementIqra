-- Phase 6C-M1: internal notices (PHASE_6_PLAN.md §5 migration B; decisions P21, P22 approved 2026-11-22; ADR-047).
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, 7 CHECKs.
-- Expand-only: three new enums, three new tables, their indexes, foreign keys and CHECKs. No existing table changes
-- (only new FKs pointing at academic_session, stored_file, user, school_class and section). No backfill.
--   1. notice — title / plain-text body, audience (FAMILIES / STAFF / ALL), scope (SCHOOL / CLASS / SECTION), status
--      (DRAFT / PUBLISHED / WITHDRAWN; a PUBLISHED notice with a future publish_at is "scheduled" — no SCHEDULED
--      status, so no job is needed to flip it), optional expiry, optional private attachment (unique FK RESTRICT),
--      actor columns (SET NULL), version. Unique (id, academic_session_id, scope) is the target of notice_target's FK.
--   2. notice_target — the classes or sections a CLASS / SECTION notice reaches. Its composite FK copies the notice's
--      session and scope (ON UPDATE CASCADE: changing a notice's scope while it has targets fails the target CHECK),
--      and the section FK (section_id, academic_session_id) keeps a target inside the notice's session.
--   3. notice_read — read receipts, (notice_id, user_id) PK; cascade with the notice or the user.
-- Review status: SQL approved by the owner 2026-11-24. Not applied anywhere yet (development, then Test, with approval).
--
-- Rollback (comment only — development/Test; the tables are new, so nothing else is lost):
--   DROP TABLE "notice_read"; DROP TABLE "notice_target"; DROP TABLE "notice";
--   DROP TYPE "NoticeStatus"; DROP TYPE "NoticeScope"; DROP TYPE "NoticeAudience";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261127000000_phase6c_notices';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';
-- CreateEnum
CREATE TYPE "NoticeAudience" AS ENUM ('FAMILIES', 'STAFF', 'ALL');

-- CreateEnum
CREATE TYPE "NoticeScope" AS ENUM ('SCHOOL', 'CLASS', 'SECTION');

-- CreateEnum
CREATE TYPE "NoticeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "notice" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "audience" "NoticeAudience" NOT NULL,
    "scope" "NoticeScope" NOT NULL,
    "status" "NoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "publish_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "attachment_file_id" TEXT,
    "created_by_id" TEXT,
    "published_by_id" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "withdrawn_by_id" TEXT,
    "withdrawn_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_target" (
    "id" TEXT NOT NULL,
    "notice_id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "scope" "NoticeScope" NOT NULL,
    "class_id" TEXT,
    "section_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notice_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_read" (
    "notice_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_read_pkey" PRIMARY KEY ("notice_id","user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notice_attachment_file_id_key" ON "notice"("attachment_file_id");

-- CreateIndex
CREATE INDEX "notice_status_publish_at_idx" ON "notice"("status", "publish_at");

-- CreateIndex
CREATE INDEX "notice_academic_session_id_status_idx" ON "notice"("academic_session_id", "status");

-- CreateIndex
CREATE INDEX "notice_created_by_id_idx" ON "notice"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "notice_id_session_scope_key" ON "notice"("id", "academic_session_id", "scope");

-- CreateIndex
CREATE INDEX "notice_target_class_id_idx" ON "notice_target"("class_id");

-- CreateIndex
CREATE INDEX "notice_target_section_id_idx" ON "notice_target"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "notice_target_notice_id_class_id_key" ON "notice_target"("notice_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "notice_target_notice_id_section_id_key" ON "notice_target"("notice_id", "section_id");

-- CreateIndex
CREATE INDEX "notice_read_user_id_idx" ON "notice_read"("user_id");

-- AddForeignKey
ALTER TABLE "notice" ADD CONSTRAINT "notice_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice" ADD CONSTRAINT "notice_attachment_file_id_fkey" FOREIGN KEY ("attachment_file_id") REFERENCES "stored_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice" ADD CONSTRAINT "notice_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice" ADD CONSTRAINT "notice_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice" ADD CONSTRAINT "notice_withdrawn_by_id_fkey" FOREIGN KEY ("withdrawn_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_target" ADD CONSTRAINT "notice_target_notice_id_academic_session_id_scope_fkey" FOREIGN KEY ("notice_id", "academic_session_id", "scope") REFERENCES "notice"("id", "academic_session_id", "scope") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_target" ADD CONSTRAINT "notice_target_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "school_class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_target" ADD CONSTRAINT "notice_target_section_id_academic_session_id_fkey" FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_read" ADD CONSTRAINT "notice_read_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_read" ADD CONSTRAINT "notice_read_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: a notice has words; staff notices are school-wide (there is no "staff of a section");
-- publish / withdraw columns are complete for their status; expiry comes after publication; version counts from 1.
ALTER TABLE "notice"
  ADD CONSTRAINT "notice_text" CHECK (btrim("title") <> '' AND btrim("body") <> ''),
  ADD CONSTRAINT "notice_staff_school_wide" CHECK ("audience" = 'FAMILIES' OR "scope" = 'SCHOOL'),
  ADD CONSTRAINT "notice_published" CHECK (
    ("status" = 'DRAFT' AND "published_at" IS NULL AND "withdrawn_at" IS NULL) OR
    ("status" <> 'DRAFT' AND "publish_at" IS NOT NULL AND "published_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "notice_withdrawn" CHECK (("status" = 'WITHDRAWN') = ("withdrawn_at" IS NOT NULL)),
  ADD CONSTRAINT "notice_expiry" CHECK ("expires_at" IS NULL OR "publish_at" IS NULL OR "expires_at" > "publish_at"),
  ADD CONSTRAINT "notice_version" CHECK ("version" >= 1);

-- Hand-written: a CLASS target names a class only, a SECTION target a section only (SCHOOL notices have none).
ALTER TABLE "notice_target"
  ADD CONSTRAINT "notice_target_kind" CHECK (
    ("scope" = 'CLASS' AND "class_id" IS NOT NULL AND "section_id" IS NULL) OR
    ("scope" = 'SECTION' AND "section_id" IS NOT NULL AND "class_id" IS NULL)
  );

COMMIT;
