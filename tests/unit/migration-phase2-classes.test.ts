import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPACITY_MAX, CAPACITY_MIN, LEVEL_MAX, LEVEL_MIN } from "@/modules/academic/academic.rules";
import { SECTION_INDEXES } from "@/modules/academic/sections.service";

/**
 * Offline review guard for migration 20261110000000 (no database). Pins what was reviewed so a later
 * edit can't silently weaken it; executing the SQL is verified on the Neon branches (design §9).
 */
const sql = readFileSync(new URL("../../prisma/migrations/20261110000000_phase2_classes_sections/migration.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("migration 20261110000000 (static review)", () => {
  it("runs in one transaction and is expand-only (no DROP, RENAME, TRUNCATE, DELETE, UPDATE)", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"/i);
    expect(code).not.toMatch(/NOT VALID/i);
  });

  it("every CHECK is present with the reviewed expression", () => {
    for (const expr of [
      `"school_setting_default_section_capacity_check"\n  CHECK ("default_section_capacity" BETWEEN ${CAPACITY_MIN} AND ${CAPACITY_MAX})`,
      `CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$')`,
      String.raw`CHECK ("name" ~ '^[ -~]+$' AND "name" = regexp_replace(btrim("name"), '\s+', ' ', 'g') AND "name" <> '')`,
      `"school_class_name_key_check" CHECK ("name_key" = lower("name"))`,
      `CHECK ("numeric_level" BETWEEN ${LEVEL_MIN} AND ${LEVEL_MAX})`,
      `CHECK ("display_order" >= 0)`,
      `CHECK ("default_section_capacity" IS NULL OR "default_section_capacity" BETWEEN ${CAPACITY_MIN} AND ${CAPACITY_MAX})`,
      `"school_class_version_check" CHECK ("version" >= 1)`,
      `CHECK ("name" ~ '^[A-Za-z0-9]+( [A-Za-z0-9]+)*$')`,
      `"section_name_key_check" CHECK ("name_key" = lower("name"))`,
      `CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)+$')`,
      `CHECK ("capacity" BETWEEN ${CAPACITY_MIN} AND ${CAPACITY_MAX})`,
      `"section_version_check" CHECK ("version" >= 1)`,
    ]) {
      expect(code, expr).toContain(expr);
    }
    expect(code.match(/CONSTRAINT "[a-z_]+_check"/g)).toHaveLength(13);
  });

  it("all three section foreign keys are ON DELETE RESTRICT", () => {
    for (const fk of ["section_academic_session_id_fkey", "section_class_id_fkey", "section_class_teacher_id_fkey"]) {
      expect(code).toMatch(new RegExp(String.raw`"${fk}" FOREIGN KEY \([^)]+\) REFERENCES "[a-z_]+"\("id"\) ON DELETE RESTRICT`));
    }
    expect(code).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });

  it("unique indexes match the names the service maps to messages; the class-teacher one is partial", () => {
    expect(code).toContain(`CREATE UNIQUE INDEX "${SECTION_INDEXES.sessionClassName.index}" ON "section"("academic_session_id", "class_id", "name_key");`);
    expect(code).toContain(`CREATE UNIQUE INDEX "${SECTION_INDEXES.sessionCode.index}" ON "section"("academic_session_id", "code");`);
    expect(code).toContain(`CREATE UNIQUE INDEX "${SECTION_INDEXES.sessionClassTeacher.index}" ON "section"("academic_session_id", "class_teacher_id") WHERE (class_teacher_id IS NOT NULL);`);
    expect(code).toContain(`CREATE UNIQUE INDEX "school_class_code_key" ON "school_class"("code");`);
    expect(code).toContain(`CREATE UNIQUE INDEX "school_class_name_key_key" ON "school_class"("name_key");`);
  });

  it("the schema expresses the partial index (preview feature), so drift checks keep it", () => {
    expect(schema).toMatch(/previewFeatures\s*=\s*\["partialIndexes"\]/);
    expect(schema).toContain(`@@unique([academicSessionId, classTeacherId], map: "${SECTION_INDEXES.sessionClassTeacher.index}", where: raw("class_teacher_id IS NOT NULL"))`);
  });

  it("the new column has a constant default (no table rewrite) of 40", () => {
    expect(code).toContain(`ADD COLUMN     "default_section_capacity" SMALLINT NOT NULL DEFAULT 40;`);
  });

  it("single-school installation (ADR-030): no school_id columns", () => {
    expect(code).not.toMatch(/school_id/i);
  });
});
