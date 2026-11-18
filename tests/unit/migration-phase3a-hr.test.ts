import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Offline review guard for migration 20261112000000 (no database). Pins the properties of the owner-approved SQL
 * in docs/PHASE_3A_M1_SCHEMA_PROPOSAL.md (approved 2026-11-18) so later edits can't silently weaken them.
 * Applying it needs the owner's separate approval per branch; executing the SQL is verified on the Neon branches.
 */
const dir = new URL("../../prisma/migrations/20261112000000_phase3a_hr_core/", import.meta.url);
const sql = readFileSync(new URL("migration.sql", dir), "utf8");
const rollback = readFileSync(new URL("ROLLBACK.sql.txt", dir), "utf8");
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const stripComments = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
const code = stripComments(sql);
const NEW_TABLES = ["department", "designation", "employee", "teacher_profile", "employee_document", "employee_service_event"];

describe("migration 20261112000000 (static review)", () => {
  it("runs in one transaction with a 5 s lock timeout and is expand-only", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(code.match(/\bCOMMIT;/g)).toHaveLength(1);
    expect(code.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(code.indexOf("BEGIN;"));
    expect(code.indexOf("SET LOCAL lock_timeout")).toBeLessThan(code.indexOf("DO $$"));
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT VALID|ALTER COLUMN|ROLLBACK/i);
    expect(sql).toContain("Review status: SQL approved by the owner 2026-11-18");
  });

  it("uses no statement that can't run inside a transaction", () => {
    expect(code).not.toMatch(/CONCURRENTLY|ALTER TYPE [^;]* ADD VALUE|\bVACUUM\b|CREATE DATABASE|ALTER SYSTEM/i);
  });

  it("refuses to run when user.employee_id already holds values, before anything is created", () => {
    const precheck = code.indexOf(`IF EXISTS (SELECT 1 FROM "user" WHERE "employee_id" IS NOT NULL) THEN`);
    expect(precheck).toBeGreaterThan(0);
    expect(code).toContain(`RAISE EXCEPTION 'Phase 3A migration refused: "user"."employee_id" already holds values. Nothing was changed.';`);
    expect(precheck).toBeLessThan(code.indexOf("CREATE TYPE"));
    expect(precheck).toBeLessThan(code.indexOf("CREATE TABLE"));
  });

  it("creates exactly the 6 HR tables and 5 enums; the only change to an existing table is the user.employee_id FK", () => {
    const created = [...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(created).toEqual([...NEW_TABLES].sort());
    const enums = [...code.matchAll(/CREATE TYPE "(\w+)" AS ENUM/g)].map((m) => m[1]).sort();
    expect(enums).toEqual(["AppointmentType", "EmployeeDocumentType", "EmploymentStatus", "ServiceEventType", "StaffType"]);
    const existingAlters = [...code.matchAll(/ALTER TABLE "([a-z_]+)" ([^\n]+)/g)].filter((m) => !NEW_TABLES.includes(m[1])).map((m) => `${m[1]} ${m[2]}`);
    expect(existingAlters).toEqual([
      `user ADD CONSTRAINT "user_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`,
    ]);
    const indexedExisting = [...code.matchAll(/CREATE (?:UNIQUE )?INDEX "[a-z_]+" ON "([a-z_]+)"/g)].map((m) => m[1]).filter((t) => !NEW_TABLES.includes(t));
    expect(indexedExisting).toEqual([]);
    expect(code.match(/CREATE (?:UNIQUE )?INDEX/g)).toHaveLength(14);
  });

  it("permanent identifiers and master-data keys are unique; one current photo per employee (schema-expressed)", () => {
    for (const idx of [
      `"department_code_key" ON "department"("code")`,
      `"department_name_key_key" ON "department"("name_key")`,
      `"designation_code_key" ON "designation"("code")`,
      `"designation_name_key_key" ON "designation"("name_key")`,
      `"employee_employee_code_key" ON "employee"("employee_code")`,
      `"employee_document_file_id_key" ON "employee_document"("file_id")`,
    ]) {
      expect(code).toContain(`CREATE UNIQUE INDEX ${idx};`);
    }
    expect(code).toContain(
      `CREATE UNIQUE INDEX "employee_document_employee_photo_key" ON "employee_document"("employee_id") WHERE (type = 'PHOTO' AND deleted_at IS NULL);`,
    );
    expect(schema).toContain(`map: "employee_document_employee_photo_key", where: raw("type = 'PHOTO' AND deleted_at IS NULL")`);
  });

  it("delete rules: people, history and files RESTRICT; actor columns SET NULL; nothing CASCADEs on delete", () => {
    const fks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)" FOREIGN KEY .*? ON DELETE (RESTRICT|SET NULL|CASCADE)/g)].map((m) => [m[1], m[2]]);
    expect(fks).toHaveLength(12);
    expect(fks.filter(([, r]) => r === "CASCADE")).toEqual([]);
    const setNull = fks.filter(([, r]) => r === "SET NULL").map(([n]) => n);
    expect(setNull).toHaveLength(4);
    for (const n of setNull) expect(n).toMatch(/_(created_by|uploaded_by|verified_by|acted_by)_id_fkey$/);
    expect(code).toContain(`"employee_document_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_file"("id") ON DELETE RESTRICT`);
    expect(code).toContain(`"employee_reports_to_id_fkey" FOREIGN KEY ("reports_to_id") REFERENCES "employee"("id") ON DELETE RESTRICT`);
  });

  it("every reviewed CHECK constraint is present", () => {
    const checks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_check)"\s+CHECK/g)].map((m) => m[1]);
    expect(checks).toHaveLength(21);
    expect(new Set(checks).size).toBe(21);
    expect(code).toContain(`CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$')`);
    expect(code).toContain(`CHECK ("dob" >= DATE '1940-01-01' AND "dob" < "joining_date")`);
    expect(code).toContain(`CHECK ("personal_phone" ~ '^[0-9]{10}$' AND ("work_phone" IS NULL OR "work_phone" ~ '^[0-9]{10}$'))`);
    expect(code).toContain(`CHECK (("employment_status" IN ('RESIGNED', 'TERMINATED', 'RETIRED')) = ("leaving_date" IS NOT NULL)`);
    expect(code).toContain(`CHECK ("reports_to_id" IS NULL OR "reports_to_id" <> "id")`);
    expect(code).toContain(`CHECK ("specializations" IS NOT NULL AND cardinality("specializations") <= 10)`);
    expect(code).toContain(`CHECK ("experience_years_before" BETWEEN 0 AND 60)`);
    expect(code).toContain(`CHECK ("type" <> 'OTHER' OR "label" IS NOT NULL)`);
  });

  it("department/designation names accept any script: Unicode shape checks, no ASCII-only or lower() rule (amendment 2026-11-11)", () => {
    for (const t of ["department", "designation"]) {
      expect(code).toMatch(new RegExp(`"${t}_name_shape_check"\\s+CHECK \\("name" IS NFC NORMALIZED AND`));
      expect(code).toMatch(new RegExp(`"${t}_name_key_shape_check"\\s+CHECK \\("name_key" IS NFKC NORMALIZED AND`));
    }
    expect(code.match(/!~ '\[\\u0001-\\u001F\\u007F\\u200B\\uFEFF\]'/g)).toHaveLength(4);
    expect(code).not.toMatch(/\^\[ -~\]|lower\(/);
  });

  it("contains no invisible characters (control and zero-width characters only as \\uXXXX escapes)", () => {
    const bad = [...sql].filter((c) => {
      const n = c.codePointAt(0)!;
      return (n < 32 && n !== 9 && n !== 10 && n !== 13) || n === 0x7f || (n >= 0x200b && n <= 0x200f) || n === 0xfeff || n === 0xa0;
    });
    expect(bad).toEqual([]);
  });

  it("collects no Aadhaar, PAN, bank, medical or salary data (H5) and stays single-school (ADR-030)", () => {
    expect(code).not.toMatch(/aadhaar|medical|bank|\bpan\b|pan_|salary/i);
    expect(code).not.toMatch(/school_id/i);
  });
});

describe("guarded rollback 20261112000000 (ROLLBACK.sql.txt — never run by Prisma)", () => {
  const rb = stripComments(rollback);

  it("is not a migration file and runs in one transaction with a lock timeout", () => {
    expect(rb.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(rb.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(rb).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it("refuses before dropping anything while any HR row or linked account exists", () => {
    const guard = rb.indexOf("RAISE EXCEPTION 'Phase 3A rollback refused:");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(rb.indexOf("DROP"));
    for (const t of NEW_TABLES) expect(rb).toContain(`(SELECT count(*) FROM "${t}")`);
    expect(rb).toContain(`(SELECT count(*) FROM "user" WHERE "employee_id" IS NOT NULL)`);
  });

  it("drops only the HR objects, never CASCADE, never stored_file or data outside HR", () => {
    expect(rb).not.toMatch(/CASCADE|TRUNCATE|stored_file/i);
    const dropped = [...rb.matchAll(/DROP TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(dropped).toEqual([...NEW_TABLES].sort());
    const deletes = [...rb.matchAll(/DELETE FROM "?([a-z_]+)"?/gi)].map((m) => m[1]);
    expect(deletes).toEqual(["_prisma_migrations"]);
    expect(rb).toContain(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112000000_phase3a_hr_core';`);
    expect(rb).toContain(`ALTER TABLE "user" DROP CONSTRAINT "user_employee_id_fkey";`);
  });
});
