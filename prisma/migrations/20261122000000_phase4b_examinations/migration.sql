-- Phase 4B: examinations — grading scales and bands, examinations, exam subjects, marks sheets (per exam subject and
-- section), examination marks, report cards; school_setting.show_rank (PHASE_4_PLAN.md; AC8–AC15 approved 2026-11-19).
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma --script`
-- (no database touched), then hand-edited: one transaction, lock_timeout, CHECK constraints.
-- Expand-only: 3 enums and 7 new tables. The only change to an EXISTING table is school_setting.show_rank
-- (NOT NULL DEFAULT false — a constant default is metadata-only in Postgres 11+, no table rewrite).
-- Every academic link carries academic_session_id in a composite foreign key (as in 4A). Nothing is dropped or renamed.
-- Review status: DRAFT — awaiting the owner's SQL approval. NOT applied to any database.
--
-- Rollback (comment only — development/Test, only while the new tables are empty):
--   DROP TABLE "report_card"; DROP TABLE "examination_marks"; DROP TABLE "marks_sheet"; DROP TABLE "exam_subject";
--   DROP TABLE "examination"; DROP TABLE "grade_band"; DROP TABLE "grade_scale";
--   ALTER TABLE "school_setting" DROP COLUMN "show_rank";
--   DROP TYPE "MarkStatus", "MarksSheetStatus", "ExaminationStatus";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261122000000_phase4b_examinations';

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;
-- Fail after 5 s instead of waiting behind (and blocking everyone behind) another transaction's lock.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ExaminationStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'MARKS_ENTRY', 'LOCKED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "MarksSheetStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "MarkStatus" AS ENUM ('PRESENT', 'ABSENT', 'EXEMPT');

-- AlterTable
ALTER TABLE "school_setting" ADD COLUMN     "show_rank" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "grade_scale" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "grade_scale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_band" (
    "id" TEXT NOT NULL,
    "scale_id" TEXT NOT NULL,
    "min_percent" DECIMAL(5,2) NOT NULL,
    "grade" VARCHAR(5) NOT NULL,
    "grade_point" DECIMAL(4,1),
    "remark" VARCHAR(60),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "grade_band_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "examination" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "grade_scale_id" TEXT NOT NULL,
    "status" "ExaminationStatus" NOT NULL DEFAULT 'DRAFT',
    "start_date" DATE,
    "end_date" DATE,
    "published_at" TIMESTAMPTZ(3),
    "published_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "examination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_subject" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "examination_id" TEXT NOT NULL,
    "class_subject_id" TEXT NOT NULL,
    "exam_date" DATE,
    "max_theory" SMALLINT NOT NULL DEFAULT 0,
    "max_practical" SMALLINT NOT NULL DEFAULT 0,
    "max_internal" SMALLINT NOT NULL DEFAULT 0,
    "pass_percent" DECIMAL(5,2),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "exam_subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marks_sheet" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "exam_subject_id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "status" "MarksSheetStatus" NOT NULL DEFAULT 'OPEN',
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "marks_sheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "examination_marks" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "marks_sheet_id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "status" "MarkStatus" NOT NULL DEFAULT 'PRESENT',
    "theory" DECIMAL(5,1),
    "practical" DECIMAL(5,1),
    "internal" DECIMAL(5,1),
    "correction_reason" VARCHAR(500),
    "entered_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "examination_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_card" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "examination_id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "remark" VARCHAR(300),
    "document_id" TEXT,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_card_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "grade_scale_name_key_key" ON "grade_scale"("name_key");

-- CreateIndex
CREATE UNIQUE INDEX "grade_band_scale_id_min_percent_key" ON "grade_band"("scale_id", "min_percent");

-- CreateIndex
CREATE UNIQUE INDEX "grade_band_scale_id_grade_key" ON "grade_band"("scale_id", "grade");

-- CreateIndex
CREATE UNIQUE INDEX "examination_academic_session_id_name_key_key" ON "examination"("academic_session_id", "name_key");

-- CreateIndex
CREATE UNIQUE INDEX "examination_id_academic_session_id_key" ON "examination"("id", "academic_session_id");

-- CreateIndex
CREATE INDEX "exam_subject_class_subject_id_idx" ON "exam_subject"("class_subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subject_examination_id_class_subject_id_key" ON "exam_subject"("examination_id", "class_subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subject_id_academic_session_id_key" ON "exam_subject"("id", "academic_session_id");

-- CreateIndex
CREATE INDEX "marks_sheet_section_id_idx" ON "marks_sheet"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "marks_sheet_exam_subject_id_section_id_key" ON "marks_sheet"("exam_subject_id", "section_id");

-- CreateIndex
CREATE UNIQUE INDEX "marks_sheet_id_academic_session_id_key" ON "marks_sheet"("id", "academic_session_id");

-- CreateIndex
CREATE INDEX "examination_marks_enrollment_id_idx" ON "examination_marks"("enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "examination_marks_marks_sheet_id_enrollment_id_key" ON "examination_marks"("marks_sheet_id", "enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_card_document_id_key" ON "report_card"("document_id");

-- CreateIndex
CREATE INDEX "report_card_enrollment_id_idx" ON "report_card"("enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_card_examination_id_enrollment_id_key" ON "report_card"("examination_id", "enrollment_id");

-- AddForeignKey
ALTER TABLE "grade_band" ADD CONSTRAINT "grade_band_scale_id_fkey" FOREIGN KEY ("scale_id") REFERENCES "grade_scale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examination" ADD CONSTRAINT "examination_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examination" ADD CONSTRAINT "examination_grade_scale_id_fkey" FOREIGN KEY ("grade_scale_id") REFERENCES "grade_scale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examination" ADD CONSTRAINT "examination_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subject" ADD CONSTRAINT "exam_subject_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subject" ADD CONSTRAINT "exam_subject_examination_id_academic_session_id_fkey" FOREIGN KEY ("examination_id", "academic_session_id") REFERENCES "examination"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subject" ADD CONSTRAINT "exam_subject_class_subject_id_academic_session_id_fkey" FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks_sheet" ADD CONSTRAINT "marks_sheet_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks_sheet" ADD CONSTRAINT "marks_sheet_exam_subject_id_academic_session_id_fkey" FOREIGN KEY ("exam_subject_id", "academic_session_id") REFERENCES "exam_subject"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks_sheet" ADD CONSTRAINT "marks_sheet_section_id_academic_session_id_fkey" FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks_sheet" ADD CONSTRAINT "marks_sheet_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks_sheet" ADD CONSTRAINT "marks_sheet_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examination_marks" ADD CONSTRAINT "examination_marks_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examination_marks" ADD CONSTRAINT "examination_marks_marks_sheet_id_academic_session_id_fkey" FOREIGN KEY ("marks_sheet_id", "academic_session_id") REFERENCES "marks_sheet"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examination_marks" ADD CONSTRAINT "examination_marks_enrollment_id_academic_session_id_fkey" FOREIGN KEY ("enrollment_id", "academic_session_id") REFERENCES "student_enrollment"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examination_marks" ADD CONSTRAINT "examination_marks_entered_by_id_fkey" FOREIGN KEY ("entered_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_card" ADD CONSTRAINT "report_card_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_card" ADD CONSTRAINT "report_card_examination_id_academic_session_id_fkey" FOREIGN KEY ("examination_id", "academic_session_id") REFERENCES "examination"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_card" ADD CONSTRAINT "report_card_enrollment_id_academic_session_id_fkey" FOREIGN KEY ("enrollment_id", "academic_session_id") REFERENCES "student_enrollment"("id", "academic_session_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_card" ADD CONSTRAINT "report_card_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "generated_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written CHECKs (new, empty tables → validated now). ───

-- Grading scales (AC8): names as other master data; bands 0–100, grade points 0–10.
ALTER TABLE "grade_scale" ADD CONSTRAINT "grade_scale_name_shape_check"
  CHECK ("name" IS NFC NORMALIZED AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> ''
     AND "name" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "grade_scale" ADD CONSTRAINT "grade_scale_name_key_shape_check"
  CHECK ("name_key" IS NFKC NORMALIZED AND "name_key" = regexp_replace(btrim("name_key"), '\s+', ' ', 'g') AND "name_key" <> ''
     AND "name_key" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "grade_scale" ADD CONSTRAINT "grade_scale_version_check" CHECK ("version" >= 1);

ALTER TABLE "grade_band" ADD CONSTRAINT "grade_band_min_percent_check" CHECK ("min_percent" BETWEEN 0 AND 100);
ALTER TABLE "grade_band" ADD CONSTRAINT "grade_band_grade_check" CHECK ("grade" = btrim("grade") AND "grade" <> '');
ALTER TABLE "grade_band" ADD CONSTRAINT "grade_band_grade_point_check" CHECK ("grade_point" IS NULL OR "grade_point" BETWEEN 0 AND 10);
ALTER TABLE "grade_band" ADD CONSTRAINT "grade_band_remark_check" CHECK ("remark" IS NULL OR ("remark" = btrim("remark") AND "remark" <> ''));

-- Examinations (AC9): names as master data; dates in order; published fields iff PUBLISHED.
ALTER TABLE "examination" ADD CONSTRAINT "examination_name_shape_check"
  CHECK ("name" IS NFC NORMALIZED AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> ''
     AND "name" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "examination" ADD CONSTRAINT "examination_name_key_shape_check"
  CHECK ("name_key" IS NFKC NORMALIZED AND "name_key" = regexp_replace(btrim("name_key"), '\s+', ' ', 'g') AND "name_key" <> ''
     AND "name_key" !~ '[\u0001-\u001F\u007F​﻿]');
ALTER TABLE "examination" ADD CONSTRAINT "examination_dates_check" CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date");
ALTER TABLE "examination" ADD CONSTRAINT "examination_published_check" CHECK (("status" = 'PUBLISHED') = ("published_at" IS NOT NULL));
ALTER TABLE "examination" ADD CONSTRAINT "examination_version_check" CHECK ("version" >= 1);

-- Exam subjects: each part 0–1000, at least one part examined, pass percent 0–100.
ALTER TABLE "exam_subject" ADD CONSTRAINT "exam_subject_max_check"
  CHECK ("max_theory" BETWEEN 0 AND 1000 AND "max_practical" BETWEEN 0 AND 1000 AND "max_internal" BETWEEN 0 AND 1000);
ALTER TABLE "exam_subject" ADD CONSTRAINT "exam_subject_total_check" CHECK ("max_theory" + "max_practical" + "max_internal" > 0);
ALTER TABLE "exam_subject" ADD CONSTRAINT "exam_subject_pass_check" CHECK ("pass_percent" IS NULL OR "pass_percent" BETWEEN 0 AND 100);
ALTER TABLE "exam_subject" ADD CONSTRAINT "exam_subject_version_check" CHECK ("version" >= 1);

-- Marks sheets (AC13): submitted fields iff SUBMITTED / APPROVED; approved fields iff APPROVED.
ALTER TABLE "marks_sheet" ADD CONSTRAINT "marks_sheet_submitted_check" CHECK (("status" IN ('SUBMITTED', 'APPROVED')) = ("submitted_at" IS NOT NULL));
ALTER TABLE "marks_sheet" ADD CONSTRAINT "marks_sheet_approved_check" CHECK (("status" = 'APPROVED') = ("approved_at" IS NOT NULL));
ALTER TABLE "marks_sheet" ADD CONSTRAINT "marks_sheet_version_check" CHECK ("version" >= 1);

-- Marks (AC10): whole or half marks ≥ 0; AB / EX carry no marks; correction reasons trimmed.
ALTER TABLE "examination_marks" ADD CONSTRAINT "examination_marks_values_check"
  CHECK ((("theory" IS NULL) OR ("theory" >= 0 AND "theory" * 2 = floor("theory" * 2)))
     AND (("practical" IS NULL) OR ("practical" >= 0 AND "practical" * 2 = floor("practical" * 2)))
     AND (("internal" IS NULL) OR ("internal" >= 0 AND "internal" * 2 = floor("internal" * 2))));
ALTER TABLE "examination_marks" ADD CONSTRAINT "examination_marks_status_check"
  CHECK ("status" = 'PRESENT' OR ("theory" IS NULL AND "practical" IS NULL AND "internal" IS NULL));
ALTER TABLE "examination_marks" ADD CONSTRAINT "examination_marks_reason_check"
  CHECK ("correction_reason" IS NULL OR ("correction_reason" = btrim("correction_reason") AND length("correction_reason") >= 3));
ALTER TABLE "examination_marks" ADD CONSTRAINT "examination_marks_version_check" CHECK ("version" >= 1);

-- Report cards (AC15): the snapshot is an object.
ALTER TABLE "report_card" ADD CONSTRAINT "report_card_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object');
ALTER TABLE "report_card" ADD CONSTRAINT "report_card_remark_check" CHECK ("remark" IS NULL OR ("remark" = btrim("remark") AND "remark" <> ''));
ALTER TABLE "report_card" ADD CONSTRAINT "report_card_version_check" CHECK ("version" >= 1);

COMMIT;
