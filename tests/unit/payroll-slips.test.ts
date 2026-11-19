import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { addAdjustmentSchema, bulkPaymentSchema, recordPaymentSchema } from "@/modules/payroll/slips.schemas";
import { addAdjustment, getSlip, listMySlips, recordBulkPayment, recordPayment, removeAdjustment } from "@/modules/payroll/slips.service";

/** Phase 3C-M5 adjustments, payments and own slips — inputs, gates over every role and the audit contract (no database). */
function roleCtx(roleKey: string, extra: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), ...extra };
}

describe("inputs", () => {
  it("adjustments: positive amounts, a note, known kinds", () => {
    expect(addAdjustmentSchema.safeParse({ slipId: "s", kind: "BONUS", amount: "1000", note: "Diwali bonus" }).success).toBe(true);
    expect(addAdjustmentSchema.safeParse({ slipId: "s", kind: "BONUS", amount: "0", note: "Diwali bonus" }).success).toBe(false);
    expect(addAdjustmentSchema.safeParse({ slipId: "s", kind: "FINE", amount: "10", note: "x x x" }).success).toBe(false);
    expect(addAdjustmentSchema.safeParse({ slipId: "s", kind: "BONUS", amount: "10", note: "" }).success).toBe(false);
  });
  it("payments: a reference unless cash; safe reference characters; real dates", () => {
    const base = { slipId: "s", amount: "100", method: "BANK_TRANSFER", reference: "UTR123", paidOn: "2026-11-01" };
    expect(recordPaymentSchema.safeParse(base).success).toBe(true);
    expect(recordPaymentSchema.safeParse({ ...base, reference: "" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...base, method: "CASH", reference: "" }).success).toBe(true);
    expect(recordPaymentSchema.safeParse({ ...base, reference: "=HYPERLINK()" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...base, paidOn: "2026-02-30" }).success).toBe(false);
    expect(bulkPaymentSchema.safeParse({ runId: "r", method: "UPI", reference: "", paidOn: "2026-11-01" }).success).toBe(false);
  });
});

describe("gates (every role)", () => {
  it("adjustments need payroll.prepare; payments need payroll.pay (Accountant, Super Admin)", async () => {
    const payers = ROLES.filter((r) => r.key === "SUPER_ADMIN" || roleCtx(r.key).permissions.has("payroll.pay")).map((r) => r.key).sort();
    expect(payers).toEqual(["ACCOUNTANT", "SUPER_ADMIN"]);
    for (const r of ROLES) {
      const ctx = roleCtx(r.key, { employeeId: "me" });
      if (r.key !== "SUPER_ADMIN" && !ctx.permissions.has("payroll.prepare")) {
        await expect(addAdjustment(ctx, { slipId: "s", kind: "BONUS", amount: "1", note: "x x x" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(removeAdjustment(ctx, "a"), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!payers.includes(r.key)) {
        await expect(recordPayment(ctx, { slipId: "s", amount: "1", method: "CASH", reference: null, paidOn: "2026-11-01" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(recordBulkPayment(ctx, { runId: "r", method: "CASH", reference: null, paidOn: "2026-11-01" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
  });
  it("own slips: every staff role has salary.self.read (SELF); Parent / Student don't; neither payroll nor own access → refused", async () => {
    for (const key of ["TEACHER", "CLASS_TEACHER", "ACCOUNTANT", "HR_MANAGER", "ADMISSION_OFFICER", "TRANSPORT_MANAGER", "LIBRARIAN", "SCHOOL_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL"]) {
      expect(roleCtx(key).permissions.get("salary.self.read")?.has("SELF"), key).toBe(true);
    }
    for (const key of ["PARENT", "STUDENT"]) {
      await expect(listMySlips(roleCtx(key)), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getSlip(roleCtx(key), "s"), key).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await listMySlips(roleCtx("TEACHER"))).toEqual({ linked: false });
  });
});

describe("service source", () => {
  const src = readFileSync(new URL("../../src/modules/payroll/slips.service.ts", import.meta.url), "utf8");
  it("own slips can't be adjusted or paid by the actor; amounts, notes and references never audited", () => {
    expect(src).toContain('throw new ForbiddenError("You can\'t adjust your own salary slip.")');
    expect(src).toContain('throw new ForbiddenError("You can\'t record a payment of your own salary.');
    for (const block of src.split("await audit(").slice(1)) {
      const call = block.slice(0, block.indexOf("});"));
      expect(call).not.toMatch(/amount|note|reference:/);
    }
  });
  it("payments never exceed the slip's net and only follow approval", () => {
    expect(src).toContain("if (new Decimal(input.amount).gt(due))");
    expect(src).toContain('run.status !== "APPROVED" && run.status !== "PAID"');
  });
});
