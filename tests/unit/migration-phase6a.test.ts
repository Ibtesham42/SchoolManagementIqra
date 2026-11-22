import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Offline review guard for migration 20261126000000 (Phase 6A-M1, PHASE_6_PLAN.md §5 migration A). */
const sql = readFileSync(new URL("../../prisma/migrations/20261126000000_phase6a_portal_accounts/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("migration 20261126000000 (static review)", () => {
  it("one transaction with a lock timeout; marked for review", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });
  it("expand-only: nothing dropped, renamed, truncated or deleted; no column type changes", () => {
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|ALTER COLUMN|NOT VALID|CONCURRENTLY/i);
  });
  it("the only UPDATE is the KI-105 waiver backfill, limited to zero late-fee lines whose text matches exactly", () => {
    const updates = [...code.matchAll(/UPDATE\s+"([a-z_]+)"/g)].map((m) => m[1]);
    expect(updates).toEqual(["fee_invoice_item"]);
    expect(code).toContain(`WHERE "kind" = 'LATE_FEE' AND "amount" = 0 AND "description" ~ '^Late fee ₹[0-9]+(\\.[0-9]{1,2})? waived:';`);
    expect(code).toContain(`"description" = 'Late fee waived'`);
    // The backfill runs BEFORE the waiver CHECK is added (so the CHECK validates the backfilled rows).
    expect(code.indexOf(`UPDATE "fee_invoice_item"`)).toBeLessThan(code.indexOf(`"fee_invoice_item_waiver" CHECK`));
  });
  it("one new table; the portal links become RESTRICT foreign keys; one person per account", () => {
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1])).toEqual(["account_activation"]);
    expect(code).toContain(`FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT`);
    expect(code).toContain(`FOREIGN KEY ("guardian_id") REFERENCES "guardian"("id") ON DELETE RESTRICT`);
    expect(code).toContain(`CHECK (num_nonnulls("employee_id", "student_id", "guardian_id") <= 1)`);
    expect(code).toContain(`FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE`);
  });
  it("custody flag defaults to visible; notifications get an idempotency key", () => {
    expect(code).toContain(`ADD COLUMN     "portal_access" BOOLEAN NOT NULL DEFAULT true;`);
    expect(code).toContain(`CREATE UNIQUE INDEX "notification_user_dedupe_key" ON "notification"("user_id", "dedupe_key") WHERE (dedupe_key IS NOT NULL);`);
  });
  it("six hand-written CHECKs", () => {
    expect([...code.matchAll(/ADD CONSTRAINT "([a-z_]+)" CHECK/g)].map((m) => m[1]).sort()).toEqual(
      ["account_activation_expiry", "account_activation_failed_attempts", "fee_invoice_item_frozen_kind", "fee_invoice_item_waiver", "user_one_person", "user_privacy_consent_pair"].sort(),
    );
  });
});
