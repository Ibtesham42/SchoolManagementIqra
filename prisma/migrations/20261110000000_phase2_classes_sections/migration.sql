-- Phase 2: classes (master data) and session-scoped sections; school-wide default section capacity.
-- Generated offline by `prisma migrate diff --from-schema <previous schema> --to-schema prisma/schema.prisma
-- --script` (no database touched — `migrate dev --create-only` was not used because it creates a shadow
-- database on the target branch), then hand-edited:
--   * wrapped in one transaction;
--   * CHECK constraints added (Prisma does not model them), all validated immediately (new/empty tables;
--     the only existing-row change is school_setting.default_section_capacity = 40, which satisfies its CHECK);
--   * the partial unique index is schema-expressed (previewFeatures = ["partialIndexes"], ADR-034), so it
--     is NOT raw SQL and later `migrate diff` / drift checks keep it.
-- Expand-only: two new tables and one new column with a constant default (no table rewrite on Postgres 11+);
-- nothing is dropped or renamed, so the previous release keeps working.
-- Single-school installation (ADR-030): no school_id columns.
-- Review status: DRAFT — AWAITING OWNER APPROVAL — do not apply.
--
-- Rollback (only before any class/section data exists; otherwise restore from Neon point-in-time instead):
--   BEGIN;
--   DROP TABLE "section";
--   DROP TABLE "school_class";
--   ALTER TABLE "school_setting" DROP COLUMN "default_section_capacity";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261110000000_phase2_classes_sections';
--   COMMIT;
-- and revert prisma/schema.prisma in the same change. Never edit this file after it has been applied.

-- All-or-nothing: any failure leaves the database exactly as it was.
BEGIN;

-- ─── 1. School settings: default capacity for new sections ──────────────────────
-- Owner decision 2026-11-10: 40 students, a configurable default (not a limit).
-- AlterTable
ALTER TABLE "school_setting" ADD COLUMN     "default_section_capacity" SMALLINT NOT NULL DEFAULT 40;

ALTER TABLE "school_setting" ADD CONSTRAINT "school_setting_default_section_capacity_check"
  CHECK ("default_section_capacity" BETWEEN 1 AND 200);

-- ─── 2. Classes (master data, never deleted) ────────────────────────────────────
-- CreateTable
CREATE TABLE "school_class" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "name_key" VARCHAR(60) NOT NULL,
    "numeric_level" SMALLINT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "default_section_capacity" SMALLINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "school_class_pkey" PRIMARY KEY ("id"),
    -- Uppercase letters/digits with single inner hyphens: "C06", "C11-SCI", "LKG".
    CONSTRAINT "school_class_code_format_check"
      CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'),
    -- Printable ASCII only (keeps SQL lower() identical to the service's toLowerCase()), already trimmed
    -- with single inner spaces, not empty.
    CONSTRAINT "school_class_name_normalized_check"
      CHECK ("name" ~ '^[ -~]+$' AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> ''),
    -- Case-insensitive uniqueness: name_key is always lower(name) (unique index below).
    CONSTRAINT "school_class_name_key_check" CHECK ("name_key" = lower("name")),
    -- -3 … 0 pre-primary (Pre-nursery, Nursery, LKG, UKG), 1–12 classes.
    CONSTRAINT "school_class_numeric_level_check" CHECK ("numeric_level" BETWEEN -3 AND 12),
    CONSTRAINT "school_class_display_order_check" CHECK ("display_order" >= 0),
    CONSTRAINT "school_class_default_section_capacity_check"
      CHECK ("default_section_capacity" IS NULL OR "default_section_capacity" BETWEEN 1 AND 200),
    CONSTRAINT "school_class_version_check" CHECK ("version" >= 1)
);

-- ─── 3. Sections (one academic session each) ────────────────────────────────────
-- CreateTable
CREATE TABLE "section" (
    "id" TEXT NOT NULL,
    "academic_session_id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "name" VARCHAR(20) NOT NULL,
    "name_key" VARCHAR(20) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "capacity" SMALLINT NOT NULL,
    "class_teacher_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "section_pkey" PRIMARY KEY ("id"),
    -- Letters/digits with single inner spaces: "A", "Rose", "Blue 2".
    CONSTRAINT "section_name_normalized_check"
      CHECK ("name" ~ '^[A-Za-z0-9]+( [A-Za-z0-9]+)*$'),
    CONSTRAINT "section_name_key_check" CHECK ("name_key" = lower("name")),
    -- "<class code>-<NAME without spaces>", e.g. "C06-A"; the class-code prefix is checked by the service.
    CONSTRAINT "section_code_format_check" CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)+$'),
    CONSTRAINT "section_capacity_check" CHECK ("capacity" BETWEEN 1 AND 200),
    CONSTRAINT "section_version_check" CHECK ("version" >= 1)
);

-- ─── 4. Indexes ─────────────────────────────────────────────────────────────────
-- CreateIndex
CREATE UNIQUE INDEX "school_class_code_key" ON "school_class"("code");

-- CreateIndex
CREATE UNIQUE INDEX "school_class_name_key_key" ON "school_class"("name_key");

-- CreateIndex
CREATE INDEX "school_class_is_active_display_order_idx" ON "school_class"("is_active", "display_order");

-- CreateIndex
CREATE INDEX "section_class_id_idx" ON "section"("class_id");

-- CreateIndex (also serves "sections of a session" and "sections of a class in a session" lookups)
CREATE UNIQUE INDEX "section_academic_session_id_class_id_name_key_key" ON "section"("academic_session_id", "class_id", "name_key");

-- CreateIndex
CREATE UNIQUE INDEX "section_academic_session_id_code_key" ON "section"("academic_session_id", "code");

-- CreateIndex — partial unique index (schema-expressed via the partialIndexes preview feature, ADR-034):
-- a user is class teacher of at most one section per academic session; sections without a class teacher
-- are not indexed. Also serves the Teacher's ASSIGNED-scope lookup (session + teacher).
CREATE UNIQUE INDEX "section_session_class_teacher_key" ON "section"("academic_session_id", "class_teacher_id") WHERE (class_teacher_id IS NOT NULL);

-- ─── 5. Foreign keys (all RESTRICT: sessions, classes and users are never hard-deleted under a section) ─
-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_academic_session_id_fkey" FOREIGN KEY ("academic_session_id") REFERENCES "academic_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "school_class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_class_teacher_id_fkey" FOREIGN KEY ("class_teacher_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
