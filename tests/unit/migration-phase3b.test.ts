import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Offline review guard for migration 20261119000000 (Phase 3B, DRAFT — awaiting the owner's SQL approval; not
 * applied). Pins the reviewed properties so later edits can't weaken them.
 */
const sql = readFileSync(new URL("../../prisma/migrations/20261119000000_phase3b_attendance_leave/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const NEW_TABLES = ["leave_type", "leave_balance", "leave_request", "employee_attendance", "holiday", "attendance_period_lock"];

describe("migration 20261119000000 (static review)", () => {
  it("one transaction with a lock timeout; expand-only", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT VALID|ALTER COLUMN|CONCURRENTLY/i);
    expect(sql).toContain("Review status: DRAFT — AWAITING OWNER APPROVAL OF THE SQL — do not apply.");
  });

  it("creates exactly the six tables; the only existing-table change is the nullable weekly_off column + its CHECK", () => {
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    const existing = [...code.matchAll(/ALTER TABLE "([a-z_]+)" ([^\n]+)/g)].filter((m) => !NEW_TABLES.includes(m[1])).map((m) => `${m[1]} ${m[2]}`);
    expect(existing).toEqual([`school_setting ADD COLUMN     "weekly_off" JSONB;`, `school_setting ADD CONSTRAINT "school_setting_weekly_off_check"`]);
  });

  it("delete rules: people/history RESTRICT, actor columns SET NULL, nothing CASCADE", () => {
    const fks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)" FOREIGN KEY .*? ON DELETE (RESTRICT|SET NULL|CASCADE)/g)].map((m) => [m[1], m[2]]);
    expect(fks).toHaveLength(13);
    expect(fks.filter(([, r]) => r === "CASCADE")).toEqual([]);
    for (const [n, r] of fks) if (r === "SET NULL") expect(n).toMatch(/_(requested_by|decided_by|marked_by|created_by|locked_by)_id_fkey$/);
  });

  it("every reviewed CHECK is present (days, half-days, balances, decisions, attendance, Unicode names)", () => {
    expect([...code.matchAll(/ADD CONSTRAINT "([a-z_]+_check)"/g)]).toHaveLength(20);
    for (const fragment of [
      `CHECK ("half_day" IS NULL OR ("from_date" = "to_date" AND "days" = 0.5))`,
      `CHECK ("days" > 0 AND "days" <= ("to_date" - "from_date" + 1))`,
      `CHECK ("allotted" >= 0 AND "carried_forward" >= 0 AND "used" >= 0)`,
      `CHECK ("is_paid" OR "carry_forward_max" = 0)`,
      `CHECK ("leave_request_id" IS NULL OR "status" IN ('ON_LEAVE', 'HALF_DAY'))`,
      `CHECK (EXTRACT(DAY FROM "month") = 1)`,
      `"name" IS NFC NORMALIZED`,
    ]) {
      expect(code, fragment).toContain(fragment);
    }
  });

  it("no sensitive data and single-school", () => {
    expect(code).not.toMatch(/aadhaar|medical|bank|\bpan\b|salary/i);
    expect(code).not.toMatch(/school_id/i);
  });
});
