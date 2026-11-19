import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { decideSalarySchema, proposeSalarySchema } from "@/modules/payroll/salaries.schemas";
import { decideSalary, getEmployeeSalaries, listPendingSalaries, proposeSalary, withdrawSalary } from "@/modules/payroll/salaries.service";

/** Phase 3C-M2 employee salaries (P7) — inputs, separation of duties and gates over every role (no database). */
function roleCtx(roleKey: string, extra: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), ...extra };
}
const proposal = { employeeId: "emp-1", structureId: "st", basic: "25000", effectiveFrom: "2026-12" };

describe("salary inputs", () => {
  it("basic with at most 2 decimals; a month; rejection needs a reason", () => {
    expect(proposeSalarySchema.safeParse(proposal).success).toBe(true);
    expect(proposeSalarySchema.safeParse({ ...proposal, basic: "25,000" }).success).toBe(false);
    expect(proposeSalarySchema.safeParse({ ...proposal, basic: "-5" }).success).toBe(false);
    expect(proposeSalarySchema.safeParse({ ...proposal, effectiveFrom: "2026-12-01" }).success).toBe(false);
    expect(decideSalarySchema.safeParse({ id: "x", version: "1", decision: "REJECT", note: "" }).success).toBe(false);
    expect(decideSalarySchema.safeParse({ id: "x", version: "1", decision: "APPROVE", note: "" }).success).toBe(true);
  });
});

describe("separation of duties (P7) — refused before any database access", () => {
  it("nobody proposes or withdraws their own salary — Super Admin included", async () => {
    await expect(proposeSalary(roleCtx("HR_MANAGER", { employeeId: "emp-1" }), proposal)).rejects.toThrow(/your own salary/);
    await expect(proposeSalary(roleCtx("SUPER_ADMIN", { employeeId: "emp-1" }), proposal)).rejects.toThrow(/your own salary/);
  });
  it("a non–Super Admin proposer or approver must be linked to a staff record", async () => {
    await expect(proposeSalary(roleCtx("HR_MANAGER"), proposal)).rejects.toThrow(/linked/);
    await expect(decideSalary(roleCtx("PRINCIPAL"), { id: "x", version: 1, decision: "APPROVE", note: "" })).rejects.toThrow(/linked/);
  });
  it("only HR Manager proposes and only the Principal approves (plus Super Admin); nobody else", async () => {
    const proposers = ROLES.filter((r) => r.key === "SUPER_ADMIN" || roleCtx(r.key).permissions.has("salary.structure.manage")).map((r) => r.key).sort();
    const approvers = ROLES.filter((r) => r.key === "SUPER_ADMIN" || roleCtx(r.key).permissions.has("payroll.approve")).map((r) => r.key).sort();
    expect(proposers).toEqual(["HR_MANAGER", "SUPER_ADMIN"]);
    expect(approvers).toEqual(["PRINCIPAL", "SUPER_ADMIN"]);
    for (const r of ROLES) {
      const ctx = roleCtx(r.key, { employeeId: "me" });
      if (!proposers.includes(r.key)) {
        await expect(proposeSalary(ctx, proposal), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(withdrawSalary(ctx, { id: "x", version: 1 }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!approvers.includes(r.key)) {
        await expect(decideSalary(ctx, { id: "x", version: 1, decision: "APPROVE", note: "" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(listPendingSalaries(ctx), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (r.key !== "SUPER_ADMIN" && !ctx.permissions.has("payroll.read")) {
        await expect(getEmployeeSalaries(ctx, "emp-1"), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
  });
});

describe("service source (database rules are covered in integration)", () => {
  const src = readFileSync(new URL("../../src/modules/payroll/salaries.service.ts", import.meta.url), "utf8");
  it("the decider can't be the proposer; audit rows never carry the basic amount or the note", () => {
    expect(src).toContain('cur.proposedById === ctx.userId) throw new ForbiddenError("You proposed this salary');
    for (const block of src.split("await audit(").slice(1)) {
      const call = block.slice(0, block.indexOf("});"));
      expect(call).not.toMatch(/basic|decisionNote|note:/);
    }
  });
});
