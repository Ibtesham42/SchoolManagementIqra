import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Offline review guard for migration 20261111000000 (no database). Pins the properties in
 * docs/PHASE_2B_STUDENTS_DESIGN.md §3 / §1a (owner-approved design) so later edits can't silently weaken them.
 * Applying it needs the owner's explicit approval per branch; executing the SQL is verified on the Neon branches.
 */
const sql = readFileSync(new URL("../../prisma/migrations/20261111000000_phase2b_admissions_students/migration.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const NEW_TABLES = [
  "admission_application",
  "admission_guardian",
  "student",
  "guardian",
  "student_guardian",
  "student_document",
  "student_enrollment",
  "roll_number_batch",
  "student_roll_number",
  "student_status_change",
];

describe("migration 20261111000000 (static review)", () => {
  it("runs in one transaction and is expand-only", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT VALID/i);
    expect(sql).toContain("Review status: design approved by the owner 2026-11-10 (D1–D12). Apply to DEVELOPMENT only after the owner's");
  });

  it("creates exactly the 10 new tables; existing tables get only the D10 column (+ its CHECK) and one unique index on section", () => {
    const created = [...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(created).toEqual([...NEW_TABLES].sort());
    const existingAlters = [...code.matchAll(/ALTER TABLE "([a-z_]+)" ([^\n]+)/g)].filter((m) => !NEW_TABLES.includes(m[1])).map((m) => `${m[1]} ${m[2]}`);
    expect(existingAlters).toEqual([
      `school_setting ADD COLUMN     "required_admission_documents" "StudentDocumentType"[] DEFAULT ARRAY['PHOTO', 'BIRTH_CERTIFICATE']::"StudentDocumentType"[];`,
      `school_setting ADD CONSTRAINT "school_setting_required_admission_documents_check"`,
    ]);
    // The enum the new column uses is created before the column.
    expect(code.indexOf(`CREATE TYPE "StudentDocumentType"`)).toBeLessThan(code.indexOf(`"required_admission_documents"`));
    const indexedExisting = [...code.matchAll(/CREATE (?:UNIQUE )?INDEX "[a-z_]+" ON "([a-z_]+)"/g)].map((m) => m[1]).filter((t) => !NEW_TABLES.includes(t));
    expect(indexedExisting).toEqual(["section"]);
    expect(code).toContain(`CREATE UNIQUE INDEX "section_id_academic_session_id_key" ON "section"("id", "academic_session_id");`);
  });

  it("partial unique indexes carry their WHERE clauses (and are schema-expressed)", () => {
    for (const [name, where] of [
      ["admission_guardian_application_parent_key", "WHERE (relation IN ('FATHER', 'MOTHER'))"],
      ["admission_guardian_application_primary_key", "WHERE (is_primary)"],
      ["student_guardian_student_primary_key", "WHERE (is_primary)"],
      ["student_document_application_photo_key", "WHERE (type = 'PHOTO' AND deleted_at IS NULL AND application_id IS NOT NULL)"],
      ["student_document_student_photo_key", "WHERE (type = 'PHOTO' AND deleted_at IS NULL AND student_id IS NOT NULL)"],
    ]) {
      expect(code).toMatch(new RegExp(`CREATE UNIQUE INDEX "${name}" ON "[a-z_]+"\\([^)]*\\) ${where.replace(/[()]/g, "\\$&")};`));
      expect(schema).toContain(`map: "${name}"`);
    }
  });

  it("KI-055: the schema states the father/mother predicate in PostgreSQL's canonical form (the applied SQL keeps IN)", () => {
    // Postgres stores `relation IN ('FATHER', 'MOTHER')` as `relation = ANY (ARRAY[…])`; Prisma compares the text.
    expect(schema).toContain(
      `map: "admission_guardian_application_parent_key", where: raw("relation = ANY (ARRAY['FATHER'::\\"GuardianRelation\\", 'MOTHER'::\\"GuardianRelation\\"])")`,
    );
    expect(schema).not.toContain(`raw("relation IN ('FATHER', 'MOTHER')")`);
  });

  it("permanent identifiers and duplicate guards are unique", () => {
    for (const idx of [
      `"student_student_code_key" ON "student"("student_code")`,
      `"student_admission_no_key" ON "student"("admission_no")`,
      `"admission_application_application_no_key" ON "admission_application"("application_no")`,
      `"admission_application_student_id_key" ON "admission_application"("student_id")`,
      `"student_enrollment_student_id_academic_session_id_key" ON "student_enrollment"("student_id", "academic_session_id")`,
      `"roll_number_batch_section_id_key" ON "roll_number_batch"("section_id")`,
      `"student_roll_number_batch_id_roll_number_key" ON "student_roll_number"("batch_id", "roll_number")`,
      `"student_roll_number_enrollment_id_key" ON "student_roll_number"("enrollment_id")`,
      `"student_document_file_id_key" ON "student_document"("file_id")`,
    ]) {
      expect(code).toContain(`CREATE UNIQUE INDEX ${idx};`);
    }
  });

  it("delete rules: records RESTRICT, actor columns SET NULL, only child rows of drafts/batches CASCADE", () => {
    const fks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)" FOREIGN KEY .*? ON DELETE (RESTRICT|SET NULL|CASCADE)/g)].map((m) => [m[1], m[2]]);
    const cascade = fks.filter(([, r]) => r === "CASCADE").map(([n]) => n).sort();
    expect(cascade).toEqual(["admission_guardian_application_id_fkey", "student_roll_number_batch_id_fkey"]);
    const setNull = fks.filter(([, r]) => r === "SET NULL").map(([n]) => n);
    for (const n of setNull) expect(n).toMatch(/_(created_by|decided_by|uploaded_by|verified_by|generated_by|finalized_by|acted_by)_id_fkey$/);
    expect(fks).toHaveLength(26);
    expect(code).toMatch(/"student_enrollment_section_id_academic_session_id_fkey" FOREIGN KEY \("section_id", "academic_session_id"\) REFERENCES "section"\("id", "academic_session_id"\) ON DELETE RESTRICT/);
  });

  it("every reviewed CHECK constraint is present", () => {
    const checks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_check)"\s+CHECK/g)].map((m) => m[1]);
    expect(checks).toHaveLength(23);
    expect(code).toContain(`CHECK ("required_admission_documents" IS NOT NULL)`);
    expect(code).toContain(`CHECK (("status" = 'APPROVED') = ("student_id" IS NOT NULL)`);
    expect(code).toContain(`CHECK ("status" = 'DRAFT' OR "application_no" IS NOT NULL)`);
    expect(code).toContain(`CHECK ("application_id" IS NOT NULL OR "student_id" IS NOT NULL)`);
    expect(code).toContain(`CHECK ("roll_number" >= 1)`);
    expect(code).toContain(`CHECK ("from_status" <> "to_status" AND btrim("reason") <> '')`);
  });

  it("collects no Aadhaar, medical or financial data (design D6) and stays single-school (ADR-030)", () => {
    expect(code).not.toMatch(/aadhaar|medical|bank|pan_|salary/i);
    expect(code).not.toMatch(/school_id/i);
  });
});
