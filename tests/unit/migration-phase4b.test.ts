import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Offline review guard for migration 20261122000000 (Phase 4B, DRAFT — awaiting the owner's SQL approval; not applied). */
const sql = readFileSync(new URL("../../prisma/migrations/20261122000000_phase4b_examinations/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const NEW_TABLES = ["grade_scale", "grade_band", "examination", "exam_subject", "marks_sheet", "examination_marks", "report_card"];

describe("migration 20261122000000 (static review)", () => {
  it("one transaction with a lock timeout; expand-only; marked as a draft", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT VALID|ALTER COLUMN|CONCURRENTLY/i);
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });

  it("creates exactly the seven tables; the only existing-table change is school_setting.show_rank (constant default)", () => {
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    const existing = [...code.matchAll(/ALTER TABLE "([a-z_]+)" (ADD (?:COLUMN|CONSTRAINT)\s+"([a-z_]+)"[^\n]*)/g)].filter((m) => !NEW_TABLES.includes(m[1]));
    expect(existing.map((m) => m[2])).toEqual([`ADD COLUMN     "show_rank" BOOLEAN NOT NULL DEFAULT false;`]);
  });

  it("session consistency: marks, sheets, exam subjects and report cards carry the session in composite FKs", () => {
    for (const fk of [
      `FOREIGN KEY ("examination_id", "academic_session_id") REFERENCES "examination"("id", "academic_session_id")`,
      `FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id")`,
      `FOREIGN KEY ("exam_subject_id", "academic_session_id") REFERENCES "exam_subject"("id", "academic_session_id")`,
      `FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id")`,
      `FOREIGN KEY ("marks_sheet_id", "academic_session_id") REFERENCES "marks_sheet"("id", "academic_session_id")`,
      `FOREIGN KEY ("enrollment_id", "academic_session_id") REFERENCES "student_enrollment"("id", "academic_session_id")`,
    ]) {
      expect(code).toContain(fk);
    }
  });

  it("delete rules: RESTRICT except actor columns (SET NULL); nothing CASCADE", () => {
    const fks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)" FOREIGN KEY .*? ON DELETE (RESTRICT|SET NULL|CASCADE)/g)].map((m) => [m[1], m[2]]);
    expect(fks).toHaveLength(20);
    expect(fks.filter(([, r]) => r === "CASCADE")).toEqual([]);
    for (const [n, r] of fks) if (r === "SET NULL") expect(n).toMatch(/_(published_by|submitted_by|approved_by|entered_by)_id_fkey$/);
  });

  it("every reviewed CHECK is present", () => {
    expect([...code.matchAll(/ADD CONSTRAINT "([a-z_]+_check)"/g)]).toHaveLength(26);
    for (const fragment of [
      `"theory" * 2 = floor("theory" * 2)`,
      `CHECK ("status" = 'PRESENT' OR ("theory" IS NULL AND "practical" IS NULL AND "internal" IS NULL))`,
      `CHECK ("max_theory" + "max_practical" + "max_internal" > 0)`,
      `CHECK (("status" = 'PUBLISHED') = ("published_at" IS NOT NULL))`,
      `CHECK (("status" = 'APPROVED') = ("approved_at" IS NOT NULL))`,
      `CHECK ("min_percent" BETWEEN 0 AND 100)`,
      `jsonb_typeof("snapshot") = 'object'`,
    ]) {
      expect(code).toContain(fragment);
    }
  });
});
