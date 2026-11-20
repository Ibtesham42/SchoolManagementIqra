-- Phase 4C: promotion decisions, homework (text) and academic calendar events (PHASE_4_PLAN.md AC16–AC18 approved
-- 2026-11-19; homework permission and text-first homework decided by the owner 2026-11-20).
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, CHECK constraints.
-- Expand-only: 2 enums and 3 new tables. No existing table or column is changed. Session-scoped links use composite
-- foreign keys (as in 4A / 4B). Nothing is dropped or renamed.
-- Review status: DRAFT — awaiting the owner's SQL approval. NOT applied to any database. Depends on 20261122000000.
--
-- Rollback (comment only — development/Test, only while the new tables are empty):
--   DROP TABLE "academic_event"; DROP TABLE "homework"; DROP TABLE "promotion_decision";
--   DROP TYPE "PromotionStatus", "PromotionKind";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123000000_phase4c_promotion_homework_calendar';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';
-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('PROMOTE', 'DETAIN', 'LEAVE');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('PROPOSED', 'CONFIRMED');

-- CreateTable
CREATE TABLE "promotion_decision" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "from_enrollment_id" TEXT NOT NULL,
    "decision" "PromotionKind" NOT NULL,
    "to_class_id" TEXT,
    "leave_as" "StudentStatus",
    "status" "PromotionStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposed_by_id" TEXT,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by_id" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "to_enrollment_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promotion_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "homework" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "class_subject_id" TEXT NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "details" VARCHAR(4000) NOT NULL,
    "assigned_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "posted_by_id" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "homework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_event" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "details" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "academic_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promotion_decision_to_enrollment_id_key" ON "promotion_decision"("to_enrollment_id");

-- CreateIndex
CREATE INDEX "promotion_decision_academic_session_id_status_idx" ON "promotion_decision"("academic_session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_decision_from_enrollment_id_academic_session_id_key" ON "promotion_decision"("from_enrollment_id", "academic_session_id");

-- CreateIndex
CREATE INDEX "homework_section_id_due_on_idx" ON "homework"("section_id", "due_on");

-- CreateIndex
CREATE INDEX "homework_class_subject_id_idx" ON "homework"("class_subject_id");

-- CreateIndex
CREATE INDEX "academic_event_academic_session_id_start_date_idx" ON "academic_event"("academic_session_id", "start_date");

-- AddForeignKey
ALTER TABLE "promotion_decision" ADD CONSTRAINT "promotion_decision_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_decision" ADD CONSTRAINT "promotion_decision_from_enrollment_id_academic_session_id_fkey" FOREIGN KEY ("from_enrollment_id", "academic_session_id") REFERENCES "student_enrollment"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_decision" ADD CONSTRAINT "promotion_decision_to_enrollment_id_fkey" FOREIGN KEY ("to_enrollment_id") REFERENCES "student_enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_decision" ADD CONSTRAINT "promotion_decision_to_class_id_fkey" FOREIGN KEY ("to_class_id") REFERENCES "school_class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_decision" ADD CONSTRAINT "promotion_decision_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_decision" ADD CONSTRAINT "promotion_decision_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_section_id_academic_session_id_fkey" FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_class_subject_id_academic_session_id_fkey" FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_event" ADD CONSTRAINT "academic_event_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ─── Hand-written CHECKs (new, empty tables → validated now). ───

-- Promotion (AC16): LEAVE has a leaving status and no class; PROMOTE / DETAIN have a class and no leaving status;
-- confirmation fields iff CONFIRMED; a next enrollment exists iff confirmed and not LEAVE.
ALTER TABLE "promotion_decision" ADD CONSTRAINT "promotion_decision_shape_check"
  CHECK ((("decision" = 'LEAVE') = ("to_class_id" IS NULL)) AND (("decision" = 'LEAVE') = ("leave_as" IS NOT NULL))
     AND ("leave_as" IS NULL OR "leave_as" <> 'ACTIVE'));
ALTER TABLE "promotion_decision" ADD CONSTRAINT "promotion_decision_confirmed_check"
  CHECK ((("status" = 'CONFIRMED') = ("confirmed_at" IS NOT NULL))
     AND (("to_enrollment_id" IS NOT NULL) = ("status" = 'CONFIRMED' AND "decision" <> 'LEAVE')));
ALTER TABLE "promotion_decision" ADD CONSTRAINT "promotion_decision_version_check" CHECK ("version" >= 1);

-- Homework (AC17): trimmed, non-empty text; due on or after the day it was set.
ALTER TABLE "homework" ADD CONSTRAINT "homework_title_check" CHECK ("title" = btrim("title") AND "title" <> '' AND "title" !~ '[\u0001-\u001F\u007F]');
ALTER TABLE "homework" ADD CONSTRAINT "homework_details_check" CHECK (btrim("details") <> '');
ALTER TABLE "homework" ADD CONSTRAINT "homework_dates_check" CHECK ("due_on" >= "assigned_on");
ALTER TABLE "homework" ADD CONSTRAINT "homework_version_check" CHECK ("version" >= 1);

-- Academic events (AC18): trimmed title, dates in order.
ALTER TABLE "academic_event" ADD CONSTRAINT "academic_event_title_check" CHECK ("title" = btrim("title") AND "title" <> '' AND "title" !~ '[\u0001-\u001F\u007F]');
ALTER TABLE "academic_event" ADD CONSTRAINT "academic_event_details_check" CHECK ("details" IS NULL OR btrim("details") <> '');
ALTER TABLE "academic_event" ADD CONSTRAINT "academic_event_dates_check" CHECK ("end_date" >= "start_date");
ALTER TABLE "academic_event" ADD CONSTRAINT "academic_event_version_check" CHECK ("version" >= 1);

COMMIT;
