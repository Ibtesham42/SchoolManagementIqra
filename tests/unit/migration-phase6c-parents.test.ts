import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Offline review guard for migration 20261129000000 (Phase 6C-M4: the PARENTS notice audience). */
const sql = readFileSync(new URL("../../prisma/migrations/20261129000000_phase6c_notice_parents/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("migration 20261129000000 (static review)", () => {
  it("one transaction with a lock timeout; marked for review", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });
  it("adds one enum value and replaces exactly one CHECK; no tables, columns or data touched", () => {
    expect(code).toContain(`ALTER TYPE "NoticeAudience" ADD VALUE 'PARENTS';`);
    expect(code).not.toMatch(/CREATE TABLE|ADD COLUMN|DROP TABLE|DROP COLUMN|\bUPDATE\s+"|\bINSERT\b|\bDELETE\s+FROM\b|RENAME/i);
    expect([...code.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1])).toEqual(["notice_staff_school_wide"]);
    expect(code).toContain(`ADD CONSTRAINT "notice_staff_school_wide" CHECK ("audience" NOT IN ('STAFF', 'ALL') OR "scope" = 'SCHOOL');`);
  });
  it("the new value is not used in the transaction that adds it", () => {
    const after = code.slice(code.indexOf("ADD VALUE 'PARENTS';") + 20);
    expect(after).not.toContain("PARENTS");
  });
});
