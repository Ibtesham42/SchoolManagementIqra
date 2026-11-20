import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { addChargeSchema, createConcessionSchema, decideConcessionSchema, proposeConcessionSchema } from "@/modules/fees/concessions.schemas";
import { addCharge, createConcession, decideConcession, listConcessions, proposeConcession, revokeConcession } from "@/modules/fees/concessions.service";
import { createFeeCategory } from "@/modules/fees/setup.service";
import { feeAccess } from "@/modules/fees/fees.policy";

/** Phase 5A-M3 concessions (FC6 maker-checker) and charges (FC18): role gates (no database) and schemas. */

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("concession roles (FC6)", () => {
  it("the Accountant proposes, the Principal approves, nobody else does either", () => {
    const proposers = ROLES.filter((r) => feeAccess(roleCtx(r.key)).proposeConcessions).map((r) => r.key).sort();
    const approvers = ROLES.filter((r) => feeAccess(roleCtx(r.key)).approveConcessions).map((r) => r.key).sort();
    expect(proposers).toEqual(["ACCOUNTANT", "SUPER_ADMIN"]);
    expect(approvers).toEqual(["PRINCIPAL", "SUPER_ADMIN"]);
  });
  it("every role without the permission is refused before the database", async () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (!hasPermission(ctx, "fee.concession.manage")) {
        await expect(createConcession(ctx, { code: "SIB", name: "Sibling", kind: "CONCESSION", calc: "PERCENT", value: "10", categoryIds: ["c1"] }), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(proposeConcession(ctx, { studentId: "s", academicSessionId: "x", concessionId: "c", reason: "Two siblings" }), role.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!hasPermission(ctx, "fee.concession.approve")) {
        await expect(decideConcession(ctx, { id: "r", version: 1, decision: "APPROVE" }), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(revokeConcession(ctx, { id: "r", version: 1 }), role.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!hasPermission(ctx, "fee.structure.manage")) {
        await expect(addCharge(ctx, { studentId: "s", academicSessionId: "x", installmentId: "i", categoryId: "c", amount: "100", note: "Club" }), role.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!feeAccess(ctx).concessions) await expect(listConcessions(ctx), role.key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("Parent (CHILDREN) and Student (SELF) see no concessions", async () => {
    for (const key of ["PARENT", "STUDENT"]) await expect(listConcessions(roleCtx(key)), key).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("review 5A-M3 M1: fee write rights count only at ALL scope", () => {
  const scoped = (key: string, scope: "SELF" | "CHILDREN" | "ASSIGNED"): AuthContext => ({
    userId: "u",
    username: "u",
    displayName: "U",
    roleKeys: ["CUSTOM"],
    sessionId: "s",
    isSuperAdmin: false,
    permissions: buildPermissionMap([{ roleKey: "CUSTOM", isSystem: false, permissionKey: key as never, scope }]),
  });
  it("a custom role holding a fee write permission at SELF / CHILDREN / ASSIGNED is refused", async () => {
    for (const scope of ["SELF", "CHILDREN", "ASSIGNED"] as const) {
      expect(feeAccess(scoped("fee.concession.manage", scope)).proposeConcessions, scope).toBe(false);
      expect(feeAccess(scoped("fee.concession.approve", scope)).approveConcessions, scope).toBe(false);
      await expect(createConcession(scoped("fee.concession.manage", scope), { code: "SIB", name: "Sibling", kind: "CONCESSION", calc: "PERCENT", value: "10", categoryIds: ["c1"] }), scope).rejects.toBeInstanceOf(ForbiddenError);
      await expect(decideConcession(scoped("fee.concession.approve", scope), { id: "r", version: 1, decision: "APPROVE" }), scope).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createFeeCategory(scoped("fee.structure.manage", scope), { code: "TUI", name: "Tuition", kind: "REGULAR", appliesTo: "ALL" }), scope).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addCharge(scoped("fee.structure.manage", scope), { studentId: "s", academicSessionId: "x", installmentId: "i", categoryId: "c", amount: "1", note: "x y" }), scope).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("concession and charge schemas", () => {
  const base = { code: "SIB", name: "Sibling concession", kind: "CONCESSION", calc: "PERCENT", value: "10", categoryIds: ["c1"] };
  it("percent 0–100, fixed above zero, at least one fee head, no duplicates", () => {
    expect(createConcessionSchema.safeParse(base).success).toBe(true);
    expect(createConcessionSchema.safeParse({ ...base, value: "100.01" }).success).toBe(false);
    expect(createConcessionSchema.safeParse({ ...base, value: "0" }).success).toBe(false);
    expect(createConcessionSchema.safeParse({ ...base, calc: "FIXED", value: "1500" }).success).toBe(true);
    expect(createConcessionSchema.safeParse({ ...base, categoryIds: [] }).success).toBe(false);
    expect(createConcessionSchema.safeParse({ ...base, categoryIds: ["c1", "c1"] }).success).toBe(false);
  });
  it("a proposal needs a reason; decisions are APPROVE or REJECT only", () => {
    expect(proposeConcessionSchema.safeParse({ studentId: "s", academicSessionId: "x", concessionId: "c", reason: "  " }).success).toBe(false);
    expect(proposeConcessionSchema.safeParse({ studentId: "s", academicSessionId: "x", concessionId: "c", reason: "Two siblings in school" }).success).toBe(true);
    expect(decideConcessionSchema.safeParse({ id: "r", version: "1", decision: "MAYBE" }).success).toBe(false);
  });
  it("charges: positive amounts with ≤ 2 decimals and a note", () => {
    const c = { studentId: "s", academicSessionId: "x", installmentId: "i", categoryId: "c", amount: "250.50", note: "Science club" };
    expect(addChargeSchema.safeParse(c).success).toBe(true);
    expect(addChargeSchema.safeParse({ ...c, amount: "0" }).success).toBe(false);
    expect(addChargeSchema.safeParse({ ...c, amount: "1.005" }).success).toBe(false);
    expect(addChargeSchema.safeParse({ ...c, note: "" }).success).toBe(false);
  });
});
