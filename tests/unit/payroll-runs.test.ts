import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { createRunSchema, reopenRunSchema } from "@/modules/payroll/runs.schemas";
import { approveRun, createRun, DEFAULT_SLIP_FORMAT, getRun, listRuns, prepareRun, reopenRun } from "@/modules/payroll/runs.service";
import { validateFormat } from "@/lib/sequence";

/** Phase 3C-M3 payroll runs — inputs, gates over every role and the locking contract (no database). */
function roleCtx(roleKey: string, extra: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), ...extra };
}

describe("run inputs and gates", () => {
  it("a month like 2026-10", () => {
    expect(createRunSchema.safeParse({ month: "2026-10" }).success).toBe(true);
    expect(createRunSchema.safeParse({ month: "2026-13" }).success).toBe(false);
  });
  it("only payroll preparers (Accountant, HR Manager, Super Admin) create and prepare; payroll readers read", async () => {
    const preparers = ROLES.filter((r) => r.key === "SUPER_ADMIN" || roleCtx(r.key).permissions.has("payroll.prepare")).map((r) => r.key).sort();
    expect(preparers).toEqual(["ACCOUNTANT", "HR_MANAGER", "SUPER_ADMIN"]);
    for (const r of ROLES) {
      const ctx = roleCtx(r.key, { employeeId: "me" });
      if (!preparers.includes(r.key)) {
        await expect(createRun(ctx, { month: "2026-10" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(prepareRun(ctx, { id: "x", version: 1 }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (r.key !== "SUPER_ADMIN" && !ctx.permissions.has("payroll.read")) {
        await expect(listRuns(ctx), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(getRun(ctx, "x"), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
  });
  it("an unlinked non–Super Admin preparer is refused", async () => {
    await expect(createRun(roleCtx("ACCOUNTANT"), { month: "2026-10" })).rejects.toThrow(/linked/);
  });
});

describe("locking contract (KI-081)", () => {
  const runs = readFileSync(new URL("../../src/modules/payroll/runs.service.ts", import.meta.url), "utf8");
  const salaries = readFileSync(new URL("../../src/modules/payroll/salaries.service.ts", import.meta.url), "utf8");
  it("prepare takes the payroll lock, then the leave-calendar lock, before reading anything", () => {
    const prep = runs.slice(runs.indexOf("export async function prepareRun"));
    expect(prep.indexOf("await lockPayroll(tx)")).toBeLessThan(prep.indexOf("await lockLeaveCalendar(tx)"));
    expect(prep.indexOf("await lockLeaveCalendar(tx)")).toBeLessThan(prep.indexOf("FROM payroll_run"));
  });
  it("salary propose / decide / withdraw take the same payroll lock", () => {
    expect(salaries.match(/await lockPayroll\(tx\)/g)).toHaveLength(3);
  });
  it("prepare refuses incomplete attendance and never audits amounts", () => {
    expect(runs).toContain("!e.summary.complete");
    const auditCall = runs.slice(runs.indexOf('action: run.status === "DRAFT"'));
    expect(auditCall.slice(0, auditCall.indexOf("});"))).not.toMatch(/gross|net|basic|deductions/i);
  });
});

describe("3C-M4 approve / reopen", () => {
  it("only payroll approvers (Principal, Super Admin) approve and reopen; reopening needs a reason", async () => {
    const approvers = ROLES.filter((r) => r.key === "SUPER_ADMIN" || roleCtx(r.key).permissions.has("payroll.approve")).map((r) => r.key).sort();
    expect(approvers).toEqual(["PRINCIPAL", "SUPER_ADMIN"]);
    for (const r of ROLES.filter((x) => !approvers.includes(x.key))) {
      await expect(approveRun(roleCtx(r.key, { employeeId: "me" }), { id: "x", version: 1 }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(reopenRun(roleCtx(r.key, { employeeId: "me" }), { id: "x", version: 1, reason: "Synthetic" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(approveRun(roleCtx("PRINCIPAL"), { id: "x", version: 1 })).rejects.toThrow(/linked/);
    expect(reopenRunSchema.safeParse({ id: "x", version: "1", reason: "  " }).success).toBe(false);
  });
  it("the default slip number format is valid (one {SEQ}, known tokens)", () => {
    expect(validateFormat(DEFAULT_SLIP_FORMAT)).toBeNull();
  });
  const src = readFileSync(new URL("../../src/modules/payroll/runs.service.ts", import.meta.url), "utf8");
  it("approval: preparer refused, own slip refused, slips recomputed and compared, attendance month locked, all after the locks", () => {
    const ap = src.slice(src.indexOf("export async function approveRun"), src.indexOf("export async function reopenRun"));
    expect(ap.indexOf("await lockPayroll(tx)")).toBeLessThan(ap.indexOf("await lockLeaveCalendar(tx)"));
    expect(ap).toContain('run.prepared_by_id === ctx.userId) throw new ForbiddenError("You prepared this payroll');
    expect(ap).toContain('throw new ForbiddenError("Your own slip is in this payroll');
    expect(ap).toContain("await computeSlipsTx(tx, run.id, run.month)");
    expect(ap).toContain("await lockAttendanceMonthTx(tx");
  });
  it("reopening is refused once payments exist and unlocks the month", () => {
    const re = src.slice(src.indexOf("export async function reopenRun"));
    expect(re).toContain("salaryPayment.count");
    expect(re).toContain("await unlockAttendanceMonthTx(tx");
  });
});
