import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { collectSchema } from "@/modules/fees/collection.schemas";
import { collectPayment, getCounterView, searchForCollection } from "@/modules/fees/collection.service";
import { normalizeReferenceFor } from "@/modules/fees/fee-rules";
import { holdsAll } from "@/modules/fees/fees.policy";
import { feeCodeSchema } from "@/modules/fees/setup.schemas";

/** Phase 5B-M1 counter collection: schema rules (FC10, FC11, FC15) and role gates before the database. */

const base = { studentId: "st1", amount: "1500.00", method: "CASH", transactionRef: "", bankName: "", instrumentDate: null, paidOn: "2026-07-15", invoiceIds: [], waiveLateFeeInvoiceIds: [], waiveReason: "", idempotencyKey: "0f8c7a3e-1b2c-4d5e-8f90-123456789abc" };

describe("collect schema", () => {
  it("cash needs no reference; other methods do; cheques need bank and date", () => {
    expect(collectSchema.safeParse(base).success).toBe(true);
    expect(collectSchema.safeParse({ ...base, method: "UPI" }).success).toBe(false);
    expect(collectSchema.safeParse({ ...base, method: "UPI", transactionRef: "UTR4021778899" }).success).toBe(true);
    expect(collectSchema.safeParse({ ...base, method: "CHEQUE", transactionRef: "004512" }).success).toBe(false);
    expect(collectSchema.safeParse({ ...base, method: "CHEQUE", transactionRef: "004512", bankName: "State Bank", instrumentDate: "2026-07-14" }).success).toBe(true);
  });
  it("amounts above zero with at most 2 decimals; a fresh idempotency key; waivers need a reason", () => {
    expect(collectSchema.safeParse({ ...base, amount: "0" }).success).toBe(false);
    expect(collectSchema.safeParse({ ...base, amount: "10.005" }).success).toBe(false);
    expect(collectSchema.safeParse({ ...base, idempotencyKey: "short" }).success).toBe(false);
    expect(collectSchema.safeParse({ ...base, waiveLateFeeInvoiceIds: ["inv1"] }).success).toBe(false);
    expect(collectSchema.safeParse({ ...base, waiveLateFeeInvoiceIds: ["inv1"], waiveReason: "Hospitalised" }).success).toBe(true);
  });
});

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}
const custom = (grants: [string, "ALL" | "SELF" | "CHILDREN"][]): AuthContext => ({
  userId: "u",
  username: "u",
  displayName: "U",
  roleKeys: ["C"],
  sessionId: "s",
  isSuperAdmin: false,
  permissions: buildPermissionMap(grants.map(([k, scope]) => ({ roleKey: "C", isSystem: false, permissionKey: k as never, scope }))),
});
const input = collectSchema.parse(base);

describe("security review 5B-M1 fixes (pure)", () => {
  it("L4: impossible dates and post-dated / stale cheques are refused", () => {
    expect(collectSchema.safeParse({ ...base, paidOn: "2026-02-31" }).success).toBe(false);
    const cheque = { ...base, method: "CHEQUE", transactionRef: "004512", bankName: "State Bank" };
    expect(collectSchema.safeParse({ ...cheque, instrumentDate: "2026-07-16" }).success).toBe(false); // after the payment date
    expect(collectSchema.safeParse({ ...cheque, instrumentDate: "2026-03-01" }).success).toBe(false); // > 90 days
    expect(collectSchema.safeParse({ ...cheque, instrumentDate: "2026-07-01" }).success).toBe(true);
  });
  it("L6: UPI / bank / card references compare as letters and digits; cheques keep their punctuation", () => {
    expect(normalizeReferenceFor("UPI", "utr-4021.7788")).toBe("UTR40217788");
    expect(normalizeReferenceFor("BANK_TRANSFER", "UTR 4021 7788")).toBe("UTR40217788");
    expect(normalizeReferenceFor("CHEQUE", "chq/004512")).toBe("CHQ/004512");
    expect(normalizeReferenceFor("CARD", "a-1")).toBeNull();
  });
  it("L5: system fee codes are reserved", () => {
    for (const c of ["LATE_FEE", "late_fee", "TRANSPORT", "OPENING_BALANCE"]) expect(feeCodeSchema.safeParse(c).success, c).toBe(false);
  });
});

describe("collection role gates (no database)", () => {
  it("only fee.collect at ALL (Accountant, Super Admin) may search, view the counter or collect", async () => {
    expect(ROLES.filter((r) => holdsAll(roleCtx(r.key), "fee.collect")).map((r) => r.key).sort()).toEqual(["ACCOUNTANT", "SUPER_ADMIN"]);
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (holdsAll(ctx, "fee.collect")) continue;
      await expect(searchForCollection(ctx, "pupil"), role.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCounterView(ctx, "st1"), role.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(collectPayment(ctx, input), role.key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("a narrow-scope fee.collect grant is refused; waiving a late fee needs fee.concession.manage", async () => {
    await expect(collectPayment(custom([["fee.collect", "SELF"]]), input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(collectPayment(custom([["fee.collect", "ALL"]]), { ...input, waiveLateFeeInvoiceIds: ["inv1"], waiveReason: "Hospitalised" })).rejects.toThrow(/can't waive/);
  });
});
