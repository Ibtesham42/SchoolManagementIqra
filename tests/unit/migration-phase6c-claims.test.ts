import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Offline review guard for migration 20261128000000 (Phase 6C-M3, PHASE_6_PLAN.md §5 migration C). */
const sql = readFileSync(new URL("../../prisma/migrations/20261128000000_phase6c_payment_claims/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("migration 20261128000000 (static review)", () => {
  it("one transaction with a lock timeout; marked for review", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });
  it("expand-only: one new table; nothing else altered; no data written", () => {
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|\bINSERT\b|ALTER COLUMN|ADD COLUMN|NOT VALID|CONCURRENTLY/i);
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1])).toEqual(["fee_payment_claim"]);
    expect([...new Set([...code.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]))]).toEqual(["fee_payment_claim"]);
  });
  it("a reference has one live claim; a receipt confirms at most one claim; RESTRICT on the money side", () => {
    expect(code).toContain(`CREATE UNIQUE INDEX "fee_payment_claim_live_ref_key" ON "fee_payment_claim"("transaction_ref") WHERE (status = ANY (ARRAY['SUBMITTED'::"FeeClaimStatus", 'CONFIRMED'::"FeeClaimStatus"]));`);
    expect(code).toContain(`CREATE UNIQUE INDEX "fee_payment_claim_payment_id_key" ON "fee_payment_claim"("payment_id");`);
    expect(code).toContain(`FOREIGN KEY ("payment_id") REFERENCES "fee_payment"("id") ON DELETE RESTRICT`);
    expect(code).toContain(`FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT`);
    expect(code).toContain(`"amount" DECIMAL(12,2) NOT NULL`);
  });
  it("seven hand-written CHECKs, including decider ≠ submitter", () => {
    expect([...code.matchAll(/ADD CONSTRAINT "([a-z_]+)" CHECK/g)].map((m) => m[1]).sort()).toEqual(
      ["fee_payment_claim_amount", "fee_payment_claim_confirmed", "fee_payment_claim_decided", "fee_payment_claim_decider", "fee_payment_claim_ref", "fee_payment_claim_rejected", "fee_payment_claim_version"].sort(),
    );
    expect(code).toContain(`CHECK ("decided_by_id" IS NULL OR "submitted_by_id" IS NULL OR "decided_by_id" <> "submitted_by_id")`);
  });
});
