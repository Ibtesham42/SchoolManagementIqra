import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Offline review guards for the S-07 and S-15 migrations (created for owner review 2026-11-18; NOT applied).
 * Pin the reviewed properties so later edits can't weaken them. Applying needs separate owner approval per branch.
 */
const read = (name: string) => readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

describe("S-07 — 20261118000000_audit_log_append_only", () => {
  const sql = read("20261118000000_audit_log_append_only");
  const c = code(sql);
  it("one transaction with a lock timeout; creates only the function and the two triggers", () => {
    expect(c.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(c.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(c).toContain("SET LOCAL lock_timeout = '5s';");
    expect([...c.matchAll(/CREATE (FUNCTION|TRIGGER) (\w+)/g)].map((m) => m[2])).toEqual(["audit_log_append_only", "audit_log_no_update_delete", "audit_log_no_truncate"]);
    expect(c).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|ALTER TABLE|TRUNCATE\s+"|INSERT/i);
  });
  it("blocks UPDATE, DELETE (per row) and TRUNCATE (per statement) on audit_log only", () => {
    expect(c).toMatch(/CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log\s+FOR EACH ROW EXECUTE FUNCTION audit_log_append_only\(\);/);
    expect(c).toMatch(/CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log\s+FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only\(\);/);
    expect(c).toContain("RAISE EXCEPTION 'audit_log is append-only'");
    expect(c).not.toMatch(/\bINSERT\b/); // inserts stay allowed
  });
  it("is marked for review, not applied", () => {
    expect(sql).toContain("Review status: CREATED FOR REVIEW 2026-11-18 — NOT APPLIED.");
  });
});

describe("S-15 — 20261118000100_stored_file_purged_at", () => {
  const sql = read("20261118000100_stored_file_purged_at");
  const c = code(sql);
  it("one transaction, lock timeout, exactly one nullable column and one CHECK on stored_file (expand-only)", () => {
    expect(c.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(c.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(c).toContain("SET LOCAL lock_timeout = '5s';");
    expect([...c.matchAll(/ALTER TABLE "(\w+)" (ADD COLUMN|ADD CONSTRAINT)\s+"(\w+)"/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`)).toEqual(["stored_file ADD COLUMN purged_at", "stored_file ADD CONSTRAINT stored_file_purged_check"]);
    expect(c).toContain(`ADD COLUMN     "purged_at" TIMESTAMPTZ(3);`); // nullable, no default → no rewrite
    expect(c).toContain(`CHECK ("purged_at" IS NULL OR ("deleted_at" IS NOT NULL AND "purged_at" >= "deleted_at"))`);
    expect(c).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT NULL DEFAULT/i);
  });
  it("the schema declares the column (nullable timestamptz) so drift checks match", () => {
    expect(schema).toMatch(/purgedAt\s+DateTime\?\s+@map\("purged_at"\) @db\.Timestamptz\(3\)/);
  });
  it("is marked for review, not applied", () => {
    expect(sql).toContain("Review status: CREATED FOR REVIEW 2026-11-18 — NOT APPLIED.");
  });
});
