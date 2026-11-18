import { describe, expect, it } from "vitest";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertEffectiveDate, createsReportingCycle, EMPLOYMENT_STATUSES, planStatusChange, STATUS_ACTIONS, type EmploymentStatus, type StatusAction } from "@/modules/hr/hr.rules";
import { changeEmploymentSchema, changeReportingSchema, changeStatusSchema } from "@/modules/hr/hr.schemas";

/** Phase 3A M4a — status machine (H11), dates, reporting cycles (H10), schemas and service gates. Synthetic only. */
function ctxFor(roleKey: string, extra: [PermissionKey, Scope][] = [], employeeId: string | null = null): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = [...role.grants.map(normalizeGrant), ...extra.map(([key, scope]) => ({ key, scope }))].map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: `u-${roleKey}`, username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), employeeId };
}

describe("status machine (H11)", () => {
  const allowed: Record<EmploymentStatus, StatusAction[]> = {
    ACTIVE: ["RESIGN", "TERMINATE", "RETIRE", "START_LEAVE"],
    ON_LEAVE: ["RESIGN", "TERMINATE", "RETIRE", "END_LEAVE"],
    RESIGNED: ["REJOIN"],
    TERMINATED: ["REJOIN"],
    RETIRED: ["REJOIN"],
  };
  for (const from of EMPLOYMENT_STATUSES) {
    for (const action of STATUS_ACTIONS) {
      const ok = allowed[from].includes(action);
      it(`${from} + ${action} → ${ok ? "allowed" : "refused"}`, () => {
        if (ok) expect(() => planStatusChange(from, action)).not.toThrow();
        else expect(() => planStatusChange(from, action)).toThrow(ConflictError);
      });
    }
  }
  it("leaving sets the matching status and event; rejoin returns to ACTIVE", () => {
    expect(planStatusChange("ACTIVE", "RETIRE")).toEqual({ next: "RETIRED", event: "RETIRED", leaving: true, rejoining: false });
    expect(planStatusChange("ON_LEAVE", "TERMINATE")).toMatchObject({ next: "TERMINATED", leaving: true });
    expect(planStatusChange("RESIGNED", "REJOIN")).toEqual({ next: "ACTIVE", event: "REJOINED", leaving: false, rejoining: true });
    expect(planStatusChange("ACTIVE", "START_LEAVE")).toMatchObject({ next: "ON_LEAVE", event: "STATUS_CHANGED" });
  });
});

describe("effective dates", () => {
  const today = "2026-11-18";
  const joiningDate = "2024-06-01";
  const bad = (kind: "status" | "employment" | "rejoin", effectiveDate: string, leavingDate?: string) => () => assertEffectiveDate(kind, { effectiveDate, joiningDate, leavingDate }, today);
  it("never before joining", () => {
    for (const k of ["status", "employment", "rejoin"] as const) expect(bad(k, "2024-05-31")).toThrow(ValidationError);
  });
  it("status changes and rejoining: today at the latest; employment changes: up to 90 days ahead", () => {
    expect(bad("status", "2026-11-19")).toThrow(ValidationError);
    expect(bad("status", today)).not.toThrow();
    expect(bad("employment", "2027-02-16")).not.toThrow();
    expect(bad("employment", "2027-02-17")).toThrow(ValidationError);
  });
  it("rejoining is on or after the leaving date", () => {
    try {
      bad("rejoin", "2025-12-31", "2026-01-01")();
      expect.unreachable();
    } catch (e) {
      expect((e as ValidationError).details?.[0]).toEqual({ path: "effectiveDate", message: "Rejoining can't be before the leaving date." });
    }
    expect(bad("rejoin", "2026-01-01", "2026-01-01")).not.toThrow();
  });
});

describe("reporting cycles (H10)", () => {
  // a → b → c (a reports to b, b reports to c); d reports to nobody.
  const graph = new Map<string, string | null>([
    ["a", "b"],
    ["b", "c"],
    ["c", null],
    ["d", null],
  ]);
  it("refuses self-reporting and any loop, direct or indirect", () => {
    expect(createsReportingCycle("a", "a", graph)).toBe(true);
    expect(createsReportingCycle("c", "a", graph)).toBe(true); // c → a → b → c
    expect(createsReportingCycle("b", "a", graph)).toBe(true);
  });
  it("allows chains without loops", () => {
    expect(createsReportingCycle("d", "a", graph)).toBe(false);
    expect(createsReportingCycle("a", "c", graph)).toBe(false);
  });
  it("an existing (corrupt) loop in the data is refused, never looped forever", () => {
    expect(createsReportingCycle("z", "x", new Map([["x", "y"], ["y", "x"]]))).toBe(true);
  });
});

describe("lifecycle schemas (strict)", () => {
  const base = { id: "e1", version: "2", effectiveDate: "2026-11-01" };
  it("status: reason 3–500 characters, known actions only, no status or code fields", () => {
    expect(changeStatusSchema.parse({ ...base, action: "RESIGN", reason: "  Moved city  ", deactivateAccount: true })).toMatchObject({ version: 2, reason: "Moved city" });
    expect(changeStatusSchema.safeParse({ ...base, action: "RESIGN", reason: "no", deactivateAccount: false }).success).toBe(false);
    expect(changeStatusSchema.safeParse({ ...base, action: "PROMOTE", reason: "Because", deactivateAccount: false }).success).toBe(false);
    expect(changeStatusSchema.safeParse({ ...base, action: "RESIGN", reason: "Because", deactivateAccount: false, employmentStatus: "ACTIVE" }).success).toBe(false);
  });
  it("employment and reporting: blank optional values → null; strict", () => {
    expect(changeEmploymentSchema.parse({ ...base, departmentId: "d", designationId: "g", appointmentType: "CONTRACT", confirmationDate: "", remarks: "" })).toMatchObject({ confirmationDate: null, remarks: null });
    expect(changeReportingSchema.parse({ ...base, reportsToId: "", remarks: "x" })).toMatchObject({ reportsToId: null, remarks: "x" });
    expect(changeEmploymentSchema.safeParse({ ...base, departmentId: "d", designationId: "g", appointmentType: "CONTRACT", confirmationDate: "", remarks: "", staffType: "TEACHING" }).success).toBe(false);
  });
});

describe("lifecycle service gates (refused before any database access)", () => {
  const status = changeStatusSchema.parse({ id: "e1", version: "1", effectiveDate: "2026-11-01", action: "RESIGN", reason: "Synthetic", deactivateAccount: false });
  it("needs employee.manage + personal tier + directory: readers and SELF-only staff are refused", async () => {
    const { changeStatus } = await import("@/modules/hr/employee-lifecycle.service");
    for (const role of ["LIBRARIAN", "PRINCIPAL", "VICE_PRINCIPAL", "TEACHER", "ACCOUNTANT", "PARENT"]) {
      await expect(changeStatus(ctxFor(role, [], "e9"), status), role).rejects.toSatisfy((e) => e instanceof ForbiddenError || e instanceof NotFoundError);
    }
  });
  it("approver ≠ subject: HR Manager and School Admin can't change their own record; Super Admin may", async () => {
    const { changeStatus, changeReporting } = await import("@/modules/hr/employee-lifecycle.service");
    for (const role of ["HR_MANAGER", "SCHOOL_ADMIN"]) {
      await expect(changeStatus(ctxFor(role, [], "e1"), status), role).rejects.toThrow(/your own employment record/);
      await expect(changeReporting(ctxFor(role, [], "e1"), changeReportingSchema.parse({ id: "e1", version: "1", effectiveDate: "2026-11-01", reportsToId: "", remarks: "" })), role).rejects.toThrow(/your own/);
    }
  });
  it("H13: deactivating the login needs user.manage — HR Manager is refused before anything is written", async () => {
    const { changeStatus } = await import("@/modules/hr/employee-lifecycle.service");
    await expect(changeStatus(ctxFor("HR_MANAGER"), { ...status, deactivateAccount: true })).rejects.toThrow(/manage users/);
  });
});
