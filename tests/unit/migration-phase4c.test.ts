import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Offline review guard for migration 20261123000000 (Phase 4C, DRAFT — awaiting the owner's SQL approval; not applied). */
const sql = readFileSync(new URL("../../prisma/migrations/20261123000000_phase4c_promotion_homework_calendar/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const NEW_TABLES = ["promotion_decision", "homework", "academic_event"];

describe("migration 20261123000000 (static review)", () => {
  it("one transaction with a lock timeout; expand-only; marked as a draft", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT VALID|ALTER COLUMN|CONCURRENTLY/i);
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });

  it("creates exactly the three tables and changes no existing table", () => {
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    const existing = [...code.matchAll(/ALTER TABLE "([a-z_]+)"/g)].filter((m) => !NEW_TABLES.includes(m[1]));
    expect(existing).toEqual([]);
  });

  it("session consistency: the source enrollment, section and class subject are tied to the row's session", () => {
    for (const fk of [
      `FOREIGN KEY ("from_enrollment_id", "academic_session_id") REFERENCES "student_enrollment"("id", "academic_session_id")`,
      `FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id")`,
      `FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id")`,
    ]) {
      expect(code).toContain(fk);
    }
    expect(code).toContain(`CREATE UNIQUE INDEX "promotion_decision_from_enrollment_id_academic_session_id_key"`);
    expect(code).toContain(`CREATE UNIQUE INDEX "promotion_decision_to_enrollment_id_key"`);
  });

  it("delete rules: RESTRICT except actor columns (SET NULL); nothing CASCADE", () => {
    const fks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)" FOREIGN KEY .*? ON DELETE (RESTRICT|SET NULL|CASCADE)/g)].map((m) => [m[1], m[2]]);
    expect(fks).toHaveLength(11);
    expect(fks.filter(([, r]) => r === "CASCADE")).toEqual([]);
    for (const [n, r] of fks) if (r === "SET NULL") expect(n).toMatch(/_(proposed_by|confirmed_by|posted_by)_id_fkey$/);
  });

  it("every reviewed CHECK is present (11; db-check pins the same number)", () => {
    expect([...code.matchAll(/ADD CONSTRAINT "([a-z_]+_check)"/g)]).toHaveLength(11);
    for (const fragment of [
      `("decision" = 'LEAVE') = ("to_class_id" IS NULL)`,
      `("decision" = 'LEAVE') = ("leave_as" IS NOT NULL)`,
      `"leave_as" <> 'ACTIVE'`,
      `("to_enrollment_id" IS NOT NULL) = ("status" = 'CONFIRMED' AND "decision" <> 'LEAVE')`,
      `CHECK ("due_on" >= "assigned_on")`,
      `CHECK ("end_date" >= "start_date")`,
    ]) {
      expect(code).toContain(fragment);
    }
  });
});
