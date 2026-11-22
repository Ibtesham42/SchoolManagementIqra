import { describe, expect, it } from "vitest";
import { visibleNavItems } from "@/components/erp/nav-items";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { canManageFeeSetup, canReadFees, canReadFeeSetup } from "@/modules/fees/fees.policy";
import { createCategorySchema, createStructureSchema, feeCodeSchema, setLateFeeRuleSchema } from "@/modules/fees/setup.schemas";
import {
  createFeeCategory,
  createFeeInstallment,
  createFeeStructure,
  listFeeCategories,
  listFeeStructures,
  setLateFeeRule,
} from "@/modules/fees/setup.service";
import { feeFormatProblem } from "@/modules/settings/settings.rules";

/** Phase 5A-M2 fee setup: access over every role, menu, number formats, schemas, service gates (no database). */

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("fee access (FC17)", () => {
  it("reads at fee.read ALL only; Parent (CHILDREN) and Student (SELF) are refused until the portal", () => {
    const readers = ROLES.filter((r) => canReadFees(roleCtx(r.key))).map((r) => r.key).sort();
    expect(readers).toEqual(["ACCOUNTANT", "PRINCIPAL", "SCHOOL_ADMIN", "SUPER_ADMIN", "VICE_PRINCIPAL"]);
    for (const key of ["PARENT", "STUDENT"]) {
      const ctx = roleCtx(key);
      // Phase 6 (P16): the Parent holds fee.read at CHILDREN (portal ledger, 6B-M3); the Student no longer holds it.
      expect(hasPermission(ctx, "fee.read"), key).toBe(key === "PARENT");
      expect(canReadFees(ctx), key).toBe(false);
      expect(canReadFeeSetup(ctx), key).toBe(false);
    }
  });
  it("only the Accountant (and Super Admin) manage fee setup", () => {
    expect(ROLES.filter((r) => canManageFeeSetup(roleCtx(r.key))).map((r) => r.key).sort()).toEqual(["ACCOUNTANT", "SUPER_ADMIN"]);
  });
  it("the Fees menu item appears exactly for setup readers", () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      const shown = visibleNavItems((k) => ctx.isSuperAdmin || hasPermission(ctx, k), (k) => scopeFor(ctx, k)).some((i) => i.href === "/erp/fees");
      expect(shown, role.key).toBe(canReadFeeSetup(ctx));
    }
  });
  it("services refuse every role without the permission before touching the database", async () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (!canReadFeeSetup(ctx)) {
        await expect(listFeeCategories(ctx), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(listFeeStructures(ctx, "s1"), role.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!canManageFeeSetup(ctx)) {
        await expect(createFeeCategory(ctx, { code: "TUI", name: "Tuition", kind: "REGULAR", appliesTo: "ALL" }), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(createFeeInstallment(ctx, { academicSessionId: "s1", name: "April", dueOn: "2026-04-10", sortOrder: 0 }), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(createFeeStructure(ctx, { academicSessionId: "s1", classId: "c1", name: "X", items: [{ categoryId: "a", installmentId: "b", amount: "1" }] }), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(setLateFeeRule(ctx, { academicSessionId: "s1", graceDays: 0, calc: "FLAT", value: "10", cap: null }), role.key).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
  });
});

describe("fee number formats (FC12)", () => {
  const sample = { code: "DPS", longestSession: "2026-27" };
  it("accepts the documented tokens", () => {
    expect(feeFormatProblem("feeReceipt", "RCT/{YYYY}/{SEQ:5}", sample)).toBeNull();
    expect(feeFormatProblem("feeReceipt", "{CODE}-R-{SEQ:6}", sample)).toBeNull();
    expect(feeFormatProblem("feeInvoice", "INV/{SESSION}/{SEQ:5}", sample)).toBeNull();
  });
  it("refuses missing or repeated {SEQ}, wrong tokens, stray braces, long numbers and an unset short code", () => {
    expect(feeFormatProblem("feeReceipt", "RCT-0001", sample)).toMatch(/exactly one \{SEQ\}/);
    expect(feeFormatProblem("feeReceipt", "{SEQ}{SEQ}", sample)).toMatch(/exactly one/);
    expect(feeFormatProblem("feeReceipt", "R/{SESSION}/{SEQ}", sample)).toMatch(/\{SESSION\} can't be used here/);
    expect(feeFormatProblem("feeInvoice", "I/{CLASS}/{SEQ}", sample)).toMatch(/\{CLASS\} can't be used here/);
    expect(feeFormatProblem("feeReceipt", "R{/{SEQ}", sample)).toMatch(/braces/);
    expect(feeFormatProblem("feeReceipt", "R/{SEQ:9}", sample)).toMatch(/at most 8 digits/);
    expect(feeFormatProblem("feeInvoice", "INVOICE-NUMBER/{SESSION}/{YYYY}/{SEQ:8}", { code: null, longestSession: "2026-27 (revised)" })).toMatch(/longer than 40/);
    expect(feeFormatProblem("feeReceipt", "{CODE}/{SEQ}", { code: null, longestSession: "2026-27" })).toMatch(/short code/);
    expect(feeFormatProblem("feeReceipt", "=R{SEQ}", sample)).toMatch(/Use letters/);
    // Review L1: only {SEQ} takes a width (lib/sequence would refuse the rest at issue time).
    expect(feeFormatProblem("feeReceipt", "R/{CODE:5}/{SEQ}", sample)).toMatch(/braces|only \{SEQ\} takes/);
    expect(feeFormatProblem("feeReceipt", "R/{YY:2}/{SEQ}", sample)).toMatch(/braces|only \{SEQ\} takes/);
  });
});

describe("fee setup schemas", () => {
  it("codes follow the database rule", () => {
    expect(feeCodeSchema.parse(" tuition-fee ")).toBe("TUITION-FEE");
    for (const bad of ["T", "-TUI", "TUI-", "TU I", "A".repeat(21)]) expect(feeCodeSchema.safeParse(bad).success, bad).toBe(false);
  });
  it("schools create only school kinds; system kinds are refused", () => {
    expect(createCategorySchema.safeParse({ code: "TUI", name: "Tuition", kind: "REGULAR", appliesTo: "ALL" }).success).toBe(true);
    expect(createCategorySchema.safeParse({ code: "LATE", name: "Late", kind: "LATE_FEE", appliesTo: "ALL" }).success).toBe(false);
  });
  it("late fee: percent ≤ 100; per-day needs a maximum", () => {
    const base = { academicSessionId: "s1", graceDays: "5", value: "10", cap: null };
    expect(setLateFeeRuleSchema.safeParse({ ...base, calc: "FLAT" }).success).toBe(true);
    expect(setLateFeeRuleSchema.safeParse({ ...base, calc: "PER_DAY" }).success).toBe(false);
    expect(setLateFeeRuleSchema.safeParse({ ...base, calc: "PER_DAY", cap: "200" }).success).toBe(true);
    expect(setLateFeeRuleSchema.safeParse({ ...base, calc: "PERCENT", value: "101" }).success).toBe(false);
    expect(setLateFeeRuleSchema.safeParse({ ...base, calc: "FLAT", value: "0" }).success).toBe(false);
  });
  it("structure items: amounts with ≤ 2 decimals, each head once per installment", () => {
    const item = { categoryId: "c1", installmentId: "i1", amount: "1500.50" };
    expect(createStructureSchema.safeParse({ academicSessionId: "s", classId: "c", name: "Class 6", items: [item] }).success).toBe(true);
    expect(createStructureSchema.safeParse({ academicSessionId: "s", classId: "c", name: "Class 6", items: [item, item] }).success).toBe(false);
    expect(createStructureSchema.safeParse({ academicSessionId: "s", classId: "c", name: "Class 6", items: [{ ...item, amount: "1.005" }] }).success).toBe(false);
    expect(createStructureSchema.safeParse({ academicSessionId: "s", classId: "c", name: "Class 6", items: [] }).success).toBe(false);
  });
});
