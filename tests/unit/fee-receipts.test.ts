import { describe, expect, it } from "vitest";
import { visibleNavItems } from "@/components/erp/nav-items";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { lateFeeFor } from "@/modules/fees/fee-calc";
import { lateFeeFrozen } from "@/modules/fees/fee-rules";
import { canReadFees, canReadReceipts, holdsAll, receiptCancelRefusal } from "@/modules/fees/fees.policy";
import { cancelReceiptSchema, receiptListSchema, receiptLookupSchema } from "@/modules/fees/receipts.schemas";
import { cancelReceipt, findReceiptId, getReceipt, listReceipts } from "@/modules/fees/receipts.service";

/** Phase 5B-M3 receipts: who reads and who cancels (FC13, review 5A L5), schemas, and gates before the database. */

function roleCtx(roleKey: string, userId = "u"): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId, username: userId, displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}
const custom = (grants: [string, "ALL" | "SELF" | "CHILDREN" | "ASSIGNED"][]): AuthContext => ({
  userId: "u",
  username: "u",
  displayName: "U",
  roleKeys: ["C"],
  sessionId: "s",
  isSuperAdmin: false,
  permissions: buildPermissionMap(grants.map(([k, scope]) => ({ roleKey: "C", isSystem: false, permissionKey: k as never, scope }))),
});

const TODAY = { recordedToday: true, closedSession: false } as const;

describe("receipt access by role (table-driven over the catalog)", () => {
  it("fee readers, collectors and cancellers at ALL read receipts; Parent and Student don't (FC17)", () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      expect(canReadReceipts(ctx), role.key).toBe(canReadFees(ctx) || holdsAll(ctx, "fee.collect") || holdsAll(ctx, "fee.refund"));
    }
    expect(canReadReceipts(roleCtx("PARENT"))).toBe(false);
    expect(canReadReceipts(roleCtx("STUDENT"))).toBe(false);
    for (const k of ["SUPER_ADMIN", "ACCOUNTANT", "PRINCIPAL"]) expect(canReadReceipts(roleCtx(k)), k).toBe(true);
  });
  it("only fee.refund at ALL may cancel (Accountant, Principal, Super Admin)", () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key, "canceller");
      const allowed = receiptCancelRefusal(ctx, { status: "SUCCESS", collectedById: "collector" , ...TODAY }) === null;
      expect(allowed, role.key).toBe(holdsAll(ctx, "fee.refund"));
      expect(allowed, role.key).toBe(["SUPER_ADMIN", "ACCOUNTANT", "PRINCIPAL"].includes(role.key));
    }
  });
  it("fee.refund at a narrow scope counts for nothing (review 5A-M3 M1)", () => {
    for (const scope of ["SELF", "CHILDREN", "ASSIGNED"] as const) {
      const ctx = custom([["fee.refund", scope]]);
      expect(canReadReceipts(ctx), scope).toBe(false);
      expect(receiptCancelRefusal(ctx, { status: "SUCCESS", collectedById: "x" , ...TODAY }), scope).toBe("NOT_PERMITTED");
    }
  });
  it("everyone who may cancel a receipt sees the Fees menu (no dead end)", () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (!holdsAll(ctx, "fee.refund")) continue;
      const items = visibleNavItems((k) => ctx.isSuperAdmin || hasPermission(ctx, k), (k) => scopeFor(ctx, k)).map((i) => i.href);
      expect(items.includes("/erp/fees"), role.key).toBe(true);
    }
  });
});

describe("cancellation rules (pure)", () => {
  const accountant = roleCtx("ACCOUNTANT", "acc");
  const principal = roleCtx("PRINCIPAL", "pri");
  const superAdmin = roleCtx("SUPER_ADMIN", "sa");
  it("canceller ≠ collector — the Super Admin included", () => {
    expect(receiptCancelRefusal(accountant, { status: "SUCCESS", collectedById: "acc" , ...TODAY })).toBe("OWN_COLLECTION");
    expect(receiptCancelRefusal(superAdmin, { status: "SUCCESS", collectedById: "sa" , ...TODAY })).toBe("OWN_COLLECTION");
    expect(receiptCancelRefusal(principal, { status: "SUCCESS", collectedById: "acc" , ...TODAY })).toBeNull();
  });
  it("a collector who is no longer a user: Super Admin only (review 5A L5)", () => {
    expect(receiptCancelRefusal(principal, { status: "SUCCESS", collectedById: null , ...TODAY })).toBe("COLLECTOR_UNKNOWN");
    expect(receiptCancelRefusal(superAdmin, { status: "SUCCESS", collectedById: null , ...TODAY })).toBeNull();
  });
  it("review M2: a canceller who also collects (Accountant) cancels only today's receipts; the Principal and Super Admin older ones", () => {
    const old = { status: "SUCCESS" as const, collectedById: "acc2", recordedToday: false, closedSession: false };
    expect(receiptCancelRefusal(accountant, old)).toBe("NOT_SAME_DAY");
    expect(receiptCancelRefusal(accountant, { ...old, recordedToday: true })).toBeNull();
    expect(receiptCancelRefusal(principal, old)).toBeNull();
    expect(receiptCancelRefusal(superAdmin, old)).toBeNull();
  });
  it("review M2: a receipt that paid a closed session's invoice — Super Admin only", () => {
    const closed = { status: "SUCCESS" as const, collectedById: "acc2", recordedToday: true, closedSession: true };
    expect(receiptCancelRefusal(accountant, closed)).toBe("SESSION_CLOSED");
    expect(receiptCancelRefusal(principal, closed)).toBe("SESSION_CLOSED");
    expect(receiptCancelRefusal(superAdmin, closed)).toBeNull();
    expect(receiptCancelRefusal(superAdmin, { ...closed, collectedById: "sa" })).toBe("OWN_COLLECTION");
  });
  it("a cancelled receipt stays cancelled", () => {
    expect(receiptCancelRefusal(principal, { status: "CANCELLED", collectedById: "acc" , ...TODAY })).toBe("ALREADY_CANCELLED");
  });
});

describe("receipt schemas", () => {
  it("cancel needs a reason of 5–500 characters without control characters; strict", () => {
    const ok = { id: "p1", version: "1", reason: "Cheque bounced" };
    expect(cancelReceiptSchema.safeParse(ok).success).toBe(true);
    expect(cancelReceiptSchema.safeParse({ ...ok, reason: "  no  " }).success).toBe(false);
    expect(cancelReceiptSchema.safeParse({ ...ok, reason: "x".repeat(501) }).success).toBe(false);
    expect(cancelReceiptSchema.safeParse({ ...ok, reason: "Bounced\u0007 cheque" }).success).toBe(false);
    expect(cancelReceiptSchema.safeParse({ ...ok, amount: "10" }).success).toBe(false);
    expect(cancelReceiptSchema.parse({ ...ok, reason: "  Entered   twice " }).reason).toBe("Entered twice");
  });
  it("lookup trims spaces; list pages are bounded", () => {
    expect(receiptLookupSchema.parse({ receiptNo: " RCT/2026/ 0001 " }).receiptNo).toBe("RCT/2026/0001");
    expect(receiptLookupSchema.safeParse({ receiptNo: "x".repeat(41) }).success).toBe(false);
    expect(receiptListSchema.parse({}).page).toBe(1);
    expect(receiptListSchema.safeParse({ page: "0" }).success).toBe(false);
    expect(receiptListSchema.safeParse({ page: "1001" }).success).toBe(false);
  });
});

describe("services refuse before touching the database", () => {
  it("every role without the right is refused by every receipt function", async () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (!canReadReceipts(ctx)) {
        await expect(listReceipts(ctx, 1), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(findReceiptId(ctx, { receiptNo: "R1" }), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(getReceipt(ctx, "p1"), role.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!holdsAll(ctx, "fee.refund")) await expect(cancelReceipt(ctx, { id: "p1", version: 1, reason: "Cheque bounced" }), role.key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("custom roles with narrow fee scopes are refused", async () => {
    const ctx = custom([["fee.refund", "CHILDREN"], ["fee.read", "CHILDREN"], ["fee.collect", "SELF"]]);
    await expect(listReceipts(ctx, 1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelReceipt(ctx, { id: "p1", version: 1, reason: "Cheque bounced" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("late fee after a cancellation (review 5B-M3 M1, pure)", () => {
  const perDay = { graceDays: 0, calc: "PER_DAY" as const, value: "10.00", cap: "1000.00" };
  it("a charged or waived late fee is fixed; a line voided by a cancellation is not", () => {
    expect(lateFeeFrozen([{ kind: "LATE_FEE", amount: "50.00", allocationCount: 1 }])).toBe(true); // charged, paid
    expect(lateFeeFrozen([{ kind: "LATE_FEE", amount: "50.00", allocationCount: 0 }])).toBe(true); // charged, unpaid
    expect(lateFeeFrozen([{ kind: "LATE_FEE", amount: "0.00", allocationCount: 0 }])).toBe(true); // waiver
    expect(lateFeeFrozen([{ kind: "LATE_FEE", amount: "0.00", allocationCount: 1 }])).toBe(false); // voided
    expect(lateFeeFrozen([{ kind: "STRUCTURE", amount: "3000.00", allocationCount: 1 }])).toBe(false);
  });
  it("PER_DAY: frozen at 5 days by a bounced cheque, cancelled — the fee keeps growing from the due date (to the cap)", () => {
    const atCheque = lateFeeFor(perDay, "2026-07-01", "2026-07-06", "3000.00");
    expect(atCheque).toBe("50.00");
    // After the cancellation the voided line no longer fixes it: worked out again as of the later payment day.
    expect(lateFeeFrozen([{ kind: "LATE_FEE", amount: "0.00", allocationCount: 1 }])).toBe(false);
    expect(lateFeeFor(perDay, "2026-07-01", "2026-08-10", "3000.00")).toBe("400.00");
    expect(lateFeeFor(perDay, "2026-07-01", "2027-01-01", "3000.00")).toBe("1000.00");
  });
});
