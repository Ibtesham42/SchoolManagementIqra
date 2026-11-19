import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Offline review guard for migration 20261121000000 (Phase 4A, DRAFT — awaiting the owner's SQL approval; not applied).
 * Pins the reviewed properties so later edits can't weaken them. scripts/db-check.ts pins the same counts.
 */
const sql = readFileSync(new URL("../../prisma/migrations/20261121000000_phase4a_teaching_attendance/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const NEW_TABLES = ["subject", "class_subject", "student_subject", "teacher_allocation", "period", "timetable_slot", "student_attendance"];

describe("migration 20261121000000 (static review)", () => {
  it("one transaction with a lock timeout; expand-only; marked as a draft", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT VALID|ALTER COLUMN|CONCURRENTLY/i);
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });

  it("creates exactly the seven tables; existing tables only gain the nullable student_weekly_off column, its CHECK and one unique index", () => {
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    const existing = [...code.matchAll(/ALTER TABLE "([a-z_]+)" (ADD (?:COLUMN|CONSTRAINT)\s+"([a-z_]+)")/g)]
      .filter((m) => !NEW_TABLES.includes(m[1]))
      .map((m) => `${m[1]}.${m[3]}`);
    expect(existing.sort()).toEqual(["school_setting.school_setting_student_weekly_off_check", "school_setting.student_weekly_off"]);
    expect(code).toMatch(/ALTER TABLE "school_setting" ADD COLUMN\s+"student_weekly_off" JSONB;/);
    const existingIndexes = [...code.matchAll(/CREATE (?:UNIQUE )?INDEX "([a-z_]+)" ON "([a-z_]+)"/g)].filter((m) => !NEW_TABLES.includes(m[2])).map((m) => m[1]);
    expect(existingIndexes).toEqual(["student_enrollment_id_academic_session_id_key"]);
  });

  it("session consistency: every link to a section, period, class subject or enrollment carries the session (composite FK)", () => {
    for (const fk of [
      `"student_subject_enrollment_id_academic_session_id_fkey" FOREIGN KEY ("enrollment_id", "academic_session_id") REFERENCES "student_enrollment"("id", "academic_session_id")`,
      `"student_subject_class_subject_id_academic_session_id_fkey" FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id")`,
      `"teacher_allocation_section_id_academic_session_id_fkey" FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id")`,
      `"teacher_allocation_class_subject_id_academic_session_id_fkey" FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id")`,
      `"timetable_slot_section_id_academic_session_id_fkey" FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id")`,
      `"timetable_slot_period_id_academic_session_id_fkey" FOREIGN KEY ("period_id", "academic_session_id") REFERENCES "period"("id", "academic_session_id")`,
      `"timetable_slot_class_subject_id_academic_session_id_fkey" FOREIGN KEY ("class_subject_id", "academic_session_id") REFERENCES "class_subject"("id", "academic_session_id")`,
      `"student_attendance_enrollment_id_academic_session_id_fkey" FOREIGN KEY ("enrollment_id", "academic_session_id") REFERENCES "student_enrollment"("id", "academic_session_id")`,
    ]) {
      expect(code).toContain(fk);
    }
  });

  it("delete rules: everything RESTRICT except the attendance marker (SET NULL); nothing CASCADE", () => {
    const fks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)" FOREIGN KEY .*? ON DELETE (RESTRICT|SET NULL|CASCADE)/g)].map((m) => [m[1], m[2]]);
    expect(fks).toHaveLength(19);
    expect(fks.filter(([, r]) => r === "CASCADE")).toEqual([]);
    expect(fks.filter(([, r]) => r === "SET NULL").map(([n]) => n)).toEqual(["student_attendance_marked_by_id_fkey"]);
  });

  it("no double-booking: one subject per section per period, one section per teacher per period", () => {
    expect(code).toContain(`CREATE UNIQUE INDEX "timetable_slot_section_id_period_id_key" ON "timetable_slot"("section_id", "period_id");`);
    expect(code).toContain(`CREATE UNIQUE INDEX "timetable_slot_teacher_period_key" ON "timetable_slot"("employee_id", "period_id") WHERE (employee_id IS NOT NULL);`);
    expect(code).toContain(`CREATE UNIQUE INDEX "teacher_allocation_section_id_class_subject_id_key" ON "teacher_allocation"("section_id", "class_subject_id");`);
    expect(code).toContain(`CREATE UNIQUE INDEX "student_attendance_enrollment_id_date_key" ON "student_attendance"("enrollment_id", "date");`);
  });

  it("every reviewed CHECK is present", () => {
    expect([...code.matchAll(/ADD CONSTRAINT "([a-z_]+_check)"/g)]).toHaveLength(16);
    for (const fragment of [
      `CHECK ("day_of_week" BETWEEN 0 AND 6)`,
      `CHECK ("number" BETWEEN 1 AND 15)`,
      `CHECK ("end_time" > "start_time")`,
      `CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$')`,
      `"name" IS NFC NORMALIZED`,
      `length("correction_reason") >= 3`,
      `jsonb_typeof("student_weekly_off") = 'object'`,
    ]) {
      expect(code).toContain(fragment);
    }
  });
});
