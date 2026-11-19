import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { createComponentSchema, createStructureSchema } from "@/modules/payroll/structures.schemas";
import { createComponent, createStructure, listComponents, listStructures, setComponentActive, setStructureActive, updateComponent, updateStructure } from "@/modules/payroll/structures.service";

/** Phase 3C-M2 salary components and structures — inputs and permission gates over every role (no database). */
function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("component and structure inputs", () => {
  it("components: code upper-cased, kind and calc from fixed lists, prorated from a checkbox", () => {
    expect(createComponentSchema.parse({ code: "hra", name: "House rent allowance", kind: "EARNING", calc: "FIXED", prorated: "on" })).toEqual({
      code: "HRA", name: "House rent allowance", kind: "EARNING", calc: "FIXED", prorated: true,
    });
    expect(createComponentSchema.safeParse({ code: "PF", name: "PF", kind: "TAX", calc: "FIXED", prorated: "" }).success).toBe(false);
    expect(createComponentSchema.safeParse({ code: "PF", name: "PF", kind: "DEDUCTION", calc: "FORMULA", prorated: "" }).success).toBe(false); // no formulas (P2)
  });
  it("structures: amounts with at most 2 decimals, no negatives, each component once, at most 30", () => {
    const ok = createStructureSchema.safeParse({ name: "Teaching", items: [{ componentId: "a", value: "1500.50" }, { componentId: "b", value: "12" }] });
    expect(ok.success).toBe(true);
    expect(createStructureSchema.safeParse({ name: "T", items: [{ componentId: "a", value: "-1" }] }).success).toBe(false);
    expect(createStructureSchema.safeParse({ name: "T", items: [{ componentId: "a", value: "1.005" }] }).success).toBe(false);
    expect(createStructureSchema.safeParse({ name: "T", items: [{ componentId: "a", value: "1" }, { componentId: "a", value: "2" }] }).success).toBe(false);
    expect(createStructureSchema.safeParse({ name: "T", items: Array.from({ length: 31 }, (_, i) => ({ componentId: `c${i}`, value: "1" })) }).success).toBe(false);
  });
});

describe("payroll structure permission gates (every role)", () => {
  it("writes: HR Manager and Super Admin only; reads: payroll.read holders too (Principal, Accountant)", async () => {
    const writers = ROLES.filter((r) => r.key === "SUPER_ADMIN" || roleCtx(r.key).permissions.has("salary.structure.manage")).map((r) => r.key).sort();
    expect(writers).toEqual(["HR_MANAGER", "SUPER_ADMIN"]);
    for (const r of ROLES) {
      const ctx = roleCtx(r.key);
      if (!writers.includes(r.key)) {
        await expect(createComponent(ctx, { code: "X", name: "X", kind: "EARNING", calc: "FIXED", prorated: true }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(updateComponent(ctx, { id: "x", version: 1, code: "X", name: "X", kind: "EARNING", calc: "FIXED", prorated: true }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(setComponentActive(ctx, { id: "x", version: 1, active: false }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(createStructure(ctx, { name: "X", items: [] }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(updateStructure(ctx, { id: "x", version: 1, name: "X", items: [] }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(setStructureActive(ctx, { id: "x", version: 1, active: false }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      const reader = r.key === "SUPER_ADMIN" || ctx.permissions.has("payroll.read") || ctx.permissions.has("salary.structure.manage");
      if (!reader) {
        await expect(listComponents(ctx), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(listStructures(ctx), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
  });
});
