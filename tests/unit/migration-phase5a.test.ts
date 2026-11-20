import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Offline review guard for migration 20261124000000 (Phase 5A fees, incl. security-review fixes M1 / M2 / M4; SQL approved and applied to development and Test 2026-11-20). */
const sql = readFileSync(new URL("../../prisma/migrations/20261124000000_phase5a_fees/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const NEW_TABLES = [
  "fee_category",
  "fee_installment",
  "fee_structure",
  "fee_structure_item",
  "fee_concession",
  "fee_concession_category",
  "student_concession",
  "late_fee_rule",
  "student_fee_charge",
  "fee_invoice",
  "fee_invoice_item",
  "fee_payment",
  "fee_payment_allocation",
];

describe("migration 20261124000000 (static review)", () => {
  it("one transaction with a lock timeout; expand-only; marked as a draft", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|NOT VALID|ALTER COLUMN|CONCURRENTLY/i);
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });

  it("creates exactly the 13 fee tables and 12 enums, and changes no existing table", () => {
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    expect([...code.matchAll(/CREATE TYPE "(\w+)"/g)]).toHaveLength(12);
    const existing = [...code.matchAll(/ALTER TABLE "([a-z_]+)"/g)].filter((m) => !NEW_TABLES.includes(m[1]));
    expect(existing).toEqual([]);
  });

  it("money is Decimal(12,2) everywhere; no float columns", () => {
    for (const col of ["amount", "subtotal", "concession_total", "late_fee", "total", "paid_amount", "concession_amount", "value", "cap"]) {
      // Column definitions only (indented lines inside CREATE TABLE), not CHECK expressions.
      const defs = [...code.matchAll(new RegExp(`^ {4}"${col}" (\\S+)`, "gm"))];
      for (const m of defs) expect(m[1].replace(/,$/, ""), col).toBe("DECIMAL(12,2)");
      if (col !== "cap" && col !== "value") expect(defs.length, col).toBeGreaterThan(0);
    }
    expect(code).not.toMatch(/DOUBLE PRECISION|\bREAL\b|\bFLOAT/);
  });

  it("per-student rows reference the enrollment by (student, session); installments are tied to the row's session", () => {
    for (const t of ["student_concession", "student_fee_charge", "fee_invoice"]) {
      expect(code).toMatch(new RegExp(`ALTER TABLE "${t}" ADD CONSTRAINT "\\w+" FOREIGN KEY \\("student_id", "academic_session_id"\\) REFERENCES "student_enrollment"\\("student_id", "academic_session_id"\\) ON DELETE RESTRICT`));
    }
    for (const t of ["fee_structure_item", "student_fee_charge", "fee_invoice"]) {
      expect(code).toMatch(new RegExp(`ALTER TABLE "${t}" ADD CONSTRAINT "\\w+" FOREIGN KEY \\("installment_id", "academic_session_id"\\) REFERENCES "fee_installment"\\("id", "academic_session_id"\\)`));
    }
  });

  it("delete rules: RESTRICT, SET NULL only for actor columns, CASCADE only from a template to its own child rows", () => {
    const fks = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)" FOREIGN KEY .*? ON DELETE (RESTRICT|SET NULL|CASCADE)/g)].map((m) => [m[1], m[2]]);
    expect(fks).toHaveLength(30);
    expect(fks.filter(([, r]) => r === "CASCADE").map(([n]) => n).sort()).toEqual(["fee_concession_category_concession_id_fkey", "fee_structure_item_structure_id_academic_session_id_fkey"]);
    for (const [n, r] of fks) if (r === "SET NULL") expect(n).toMatch(/_(proposed_by|decided_by|created_by|issued_by|cancelled_by|collected_by)_id_fkey$/);
  });

  it("allocations are tied together: item ∈ invoice, payment and invoice of the same student (review M2)", () => {
    for (const fk of [
      `FOREIGN KEY ("payment_id", "student_id") REFERENCES "fee_payment"("id", "student_id")`,
      `FOREIGN KEY ("invoice_item_id", "invoice_id") REFERENCES "fee_invoice_item"("id", "invoice_id")`,
      `FOREIGN KEY ("invoice_id", "student_id") REFERENCES "fee_invoice"("id", "student_id")`,
    ]) {
      expect(code).toContain(fk);
    }
  });

  it("issued receipts and allocations can't be rewritten or deleted (review M1 triggers)", () => {
    expect(code).toContain(`CREATE TRIGGER fee_payment_immutable BEFORE UPDATE OR DELETE ON "fee_payment"`);
    expect(code).toContain(`CREATE TRIGGER fee_payment_allocation_immutable BEFORE UPDATE OR DELETE ON "fee_payment_allocation"`);
    for (const col of ["receipt_no", "student_id", "amount", "method", "transaction_ref", "paid_on", "idempotency_key", "receipt_snapshot"]) {
      expect(code, col).toMatch(new RegExp(`NEW\.${col}(::text)? (<>|IS DISTINCT FROM) OLD\.${col}`));
    }
    expect(code).toContain("NEW.print_count < OLD.print_count");
    expect(code).toContain("OLD.status = 'CANCELLED' AND (NEW.status <> 'CANCELLED'");
    expect(code).toContain("OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at");
  });

  it("the nine partial unique indexes (idempotent generation, one live concession / rule / structure, references)", () => {
    for (const fragment of [
      `"fee_structure_active_key" ON "fee_structure" ("academic_session_id", "class_id") WHERE "is_active"`,
      `"late_fee_rule_active_key" ON "late_fee_rule" ("academic_session_id") WHERE "is_active"`,
      `"student_concession_live_key" ON "student_concession" ("student_id", "academic_session_id", "concession_id") WHERE "status" IN ('PROPOSED', 'APPROVED')`,
      `"fee_invoice_live_installment_key" ON "fee_invoice" ("student_id", "academic_session_id", "installment_id") WHERE "deleted_at" IS NULL AND "kind" = 'INSTALLMENT'`,
      `"fee_invoice_live_opening_key" ON "fee_invoice" ("student_id", "academic_session_id") WHERE "deleted_at" IS NULL AND "kind" = 'OPENING_BALANCE'`,
      `"fee_payment_live_utr_key" ON "fee_payment" ("transaction_ref") WHERE "method" IN ('UPI', 'BANK_TRANSFER') AND "status" = 'SUCCESS'`,
      `"fee_payment_live_cheque_key" ON "fee_payment" ("transaction_ref", "bank_name", "instrument_date") WHERE "method" = 'CHEQUE' AND "status" = 'SUCCESS'`,
      `"fee_payment_live_card_key" ON "fee_payment" ("transaction_ref") WHERE "method" = 'CARD' AND "status" = 'SUCCESS'`,
      `"student_fee_charge_live_source_key" ON "student_fee_charge" ("student_id", "academic_session_id", "installment_id", "source_ref") WHERE "source" = 'TRANSPORT' AND "deleted_at" IS NULL`,
    ]) {
      expect(code).toContain(`CREATE UNIQUE INDEX ${fragment}`);
    }
    expect(code).toContain(`CREATE UNIQUE INDEX "fee_payment_receipt_no_key"`);
    expect(code).toContain(`CREATE UNIQUE INDEX "fee_payment_idempotency_key_key"`);
    expect(code).toContain(`CREATE UNIQUE INDEX "fee_invoice_invoice_no_key"`);
  });

  it("every reviewed CHECK is present (50; db-check pins the same number)", () => {
    expect([...code.matchAll(/ADD CONSTRAINT "([a-z_]+)" CHECK/g)]).toHaveLength(50);
    for (const fragment of [
      `CHECK ("total" = "subtotal" - "concession_total" + "late_fee")`,
      `CHECK ("paid_amount" <= "total")`,
      `CHECK (("status" = 'CANCELLED') = ("deleted_at" IS NOT NULL))`,
      `CHECK ("paid_amount" >= 0 AND "paid_amount" <= "amount" - "concession_amount")`,
      `CHECK (("method" = 'CASH') = ("transaction_ref" IS NULL))`,
      `CHECK (("status" = 'PROPOSED') = ("decided_at" IS NULL))`,
      `CHECK ("value" > 0 AND ("calc" <> 'PERCENT' OR "value" <= 100))`,
      `CHECK ("amount" > 0)`,
      `CHECK ("calc" <> 'PER_DAY' OR "cap" IS NOT NULL)`,
      `CHECK ("cancelled_by_id" IS NULL OR "collected_by_id" IS NULL OR "cancelled_by_id" <> "collected_by_id")`,
      `CHECK ("decided_by_id" IS NULL OR "proposed_by_id" IS NULL OR "decided_by_id" <> "proposed_by_id")`,
      `"transaction_ref" ~ '^[A-Z0-9][A-Z0-9/_.-]{3,39}$'`,
    ]) {
      expect(code).toContain(fragment);
    }
  });
});
