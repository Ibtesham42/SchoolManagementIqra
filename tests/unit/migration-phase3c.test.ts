import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Offline review guard for migration 20261120000000 (Phase 3C payroll, DRAFT — awaiting the owner's SQL approval; not
 * applied). Pins the reviewed properties so later edits can't weaken them. scripts/db-check.ts pins the same counts.
 */
const sql = readFileSync(new URL("../../prisma/migrations/20261120000000_phase3c_payroll/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const NEW_TABLES = [
  "salary_component", "salary_structure", "salary_structure_item", "employee_salary", "payroll_run", "payroll_slip",
  "payroll_adjustment", "salary_payment",
];

describe("migration 20261120000000 (static review)", () => {
  it("one transaction with a lock timeout; expand-only; marked as a draft", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT VALID|ALTER COLUMN|CONCURRENTLY/i);
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });

  it("creates exactly the eight payroll tables (no salary advances — P9 deferred)", () => {
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    expect(code).not.toMatch(/salary_advance/);
  });

  it("existing tables only gain nullable columns, the PAN HMAC unique index and CHECKs on those columns", () => {
    const existing = [...code.matchAll(/ALTER TABLE "([a-z_]+)" (ADD (?:COLUMN|CONSTRAINT)\s+"([a-z_]+)"[^\n]*)/g)]
      .filter((m) => !NEW_TABLES.includes(m[1]))
      .map((m) => `${m[1]}.${m[3]}`);
    expect(existing.sort()).toEqual(
      ["employee.bank_account_enc", "employee.employee_bank_pair_check", "employee.employee_pan_pair_check", "school_setting.payroll_day_basis"].sort(),
    );
    const employeeColumns = code.slice(code.indexOf('ALTER TABLE "employee" ADD COLUMN'), code.indexOf(";", code.indexOf('ALTER TABLE "employee" ADD COLUMN')));
    expect([...employeeColumns.matchAll(/ADD COLUMN\s+"([a-z_]+)" ([A-Z0-9()]+)/g)].map((m) => m[1]).sort()).toEqual(
      ["bank_account_enc", "bank_account_hmac", "bank_account_name", "bank_ifsc", "pan_enc", "pan_hmac"].sort(),
    );
    expect(employeeColumns).not.toMatch(/NOT NULL|DEFAULT/);
    expect(code).toMatch(/ALTER TABLE "school_setting" ADD COLUMN\s+"payroll_day_basis" "PayrollDayBasis";/); // no default (P3)
    expect(code).toContain('CREATE UNIQUE INDEX "employee_pan_hmac_key" ON "employee"("pan_hmac");');
  });

  it("delete rules: payroll history RESTRICT, actor columns SET NULL, nothing CASCADE", () => {
    const fks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)" FOREIGN KEY .*? ON DELETE (RESTRICT|SET NULL|CASCADE)/g)].map((m) => [m[1], m[2]]);
    expect(fks).toHaveLength(15);
    expect(fks.filter(([, r]) => r === "CASCADE")).toEqual([]);
    for (const [n, r] of fks) {
      if (r === "SET NULL") expect(n).toMatch(/_(proposed_by|decided_by|prepared_by|approved_by|created_by|paid_by)_id_fkey$/);
      else expect(n).not.toMatch(/_by_id_fkey$/);
    }
  });

  it("every reviewed CHECK and partial unique index is present", () => {
    expect([...code.matchAll(/ADD CONSTRAINT "([a-z_]+_check)"/g)]).toHaveLength(28);
    for (const fragment of [
      `CHECK (EXTRACT(DAY FROM "effective_from") = 1)`,
      `CHECK (EXTRACT(DAY FROM "month") = 1)`,
      `"total_net" = "total_gross" - "total_deductions"`,
      `"net" >= 0 AND "net" = "gross" - "total_deductions"`,
      `"paid_days" + "lop_days" + "off_rolls_days" = "month_days"`,
      `("status" IN ('APPROVED', 'PAID')) = ("approved_at" IS NOT NULL)`,
      `("status" <> 'REJECTED' OR "decision_note" IS NOT NULL)`,
      `("pan_enc" IS NULL) = ("pan_hmac" IS NULL)`,
      `"bank_ifsc" ~ '^[A-Z]{4}0[A-Z0-9]{6}$'`,
      `CHECK ("amount" > 0)`,
      `CHECK ("value" >= 0)`,
    ]) {
      expect(code).toContain(fragment);
    }
    expect(code).toContain(`CREATE UNIQUE INDEX "employee_salary_one_pending_key" ON "employee_salary"("employee_id") WHERE "status" = 'PROPOSED';`);
    expect(code).toContain(
      `CREATE UNIQUE INDEX "employee_salary_one_approved_per_month_key" ON "employee_salary"("employee_id", "effective_from") WHERE "status" = 'APPROVED';`,
    );
    expect(code).toContain(`CREATE UNIQUE INDEX "salary_payment_method_reference_key" ON "salary_payment"("method", "reference") WHERE "reference" IS NOT NULL;`);
  });

  it("money columns are Decimal(12,2) and day counts Decimal(5,1) — never floats", () => {
    expect(code).not.toMatch(/DOUBLE PRECISION|\bREAL\b|\bFLOAT/i);
    for (const col of ["basic", "value", "total_gross", "total_deductions", "total_net", "gross", "net", "amount"]) {
      expect(code).toMatch(new RegExp(`"${col}" DECIMAL\\(12,2\\)`));
    }
    expect(code).toMatch(/"lop_days" DECIMAL\(5,1\)/);
    expect(code).toMatch(/"paid_days" DECIMAL\(5,1\)/);
  });
});
