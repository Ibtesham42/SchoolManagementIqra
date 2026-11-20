import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Offline review guard for migration 20261125000000 (Phase 5A-M4, KI-103; SQL approved and applied to development and Test 2026-11-20). */
const sql = readFileSync(new URL("../../prisma/migrations/20261125000000_phase5a_invoice_structure/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("migration 20261125000000 (static review)", () => {
  it("one transaction with a lock timeout; expand-only; marked", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT VALID|ALTER COLUMN|CONCURRENTLY|CREATE TABLE/i);
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });
  it("only fee_invoice changes: a nullable column, an index, a session-bound FK and the kind CHECK", () => {
    expect([...code.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]).every((t) => t === "fee_invoice")).toBe(true);
    expect(code).toContain(`ADD COLUMN     "structure_id" TEXT;`);
    expect(code).toContain(`FOREIGN KEY ("structure_id", "academic_session_id") REFERENCES "fee_structure"("id", "academic_session_id") ON DELETE RESTRICT`);
    expect(code).toContain(`CHECK (("kind" = 'INSTALLMENT') = ("structure_id" IS NOT NULL))`);
    expect([...code.matchAll(/ADD CONSTRAINT "[a-z_]+" CHECK/g)]).toHaveLength(1);
  });
});
