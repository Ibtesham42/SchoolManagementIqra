import { describe, expect, it } from "vitest";
import { authorize, buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { ALL_PERMISSION_KEYS, ROLES, normalizeGrant, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { ForbiddenError } from "@/lib/errors";
import { newPermissionGrants, planSeed } from "../../prisma/seed-core";

/**
 * Phase 2B S2 — admissions & student-document permissions (design §4, owner decisions D2, D8).
 * Table-driven over every catalog role through the real authorize(), so these are the server-side rules
 * the services will call — not menu visibility.
 */
function ctxFor(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: normalizeGrant(g).key, scope: normalizeGrant(g).scope }));
  return { userId: `u-${roleKey}`, username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}
const scopeOf = (roleKey: string, key: PermissionKey): Scope | null => {
  try {
    return authorize(ctxFor(roleKey), key);
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
};
const holders = (key: PermissionKey) => ROLES.map((r) => r.key).filter((k) => scopeOf(k, key) !== null);

describe("admission and student-document permissions (D2)", () => {
  it("student.document.manage exists with a clear description", () => {
    expect(ALL_PERMISSION_KEYS).toContain("student.document.manage");
  });

  it.each<[PermissionKey, string[]]>([
    ["admission.read", ["SUPER_ADMIN", "SCHOOL_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL", "ADMISSION_OFFICER"]],
    ["admission.create", ["SUPER_ADMIN", "SCHOOL_ADMIN", "ADMISSION_OFFICER"]],
    ["admission.approve", ["SUPER_ADMIN", "SCHOOL_ADMIN", "PRINCIPAL"]],
    ["student.document.read", ["SUPER_ADMIN", "SCHOOL_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL", "ADMISSION_OFFICER"]],
    ["student.document.manage", ["SUPER_ADMIN", "SCHOOL_ADMIN", "ADMISSION_OFFICER"]],
  ])("%s is held by exactly %j (ALL scope)", (key, expected) => {
    expect(holders(key)).toEqual(expected);
    for (const r of expected) expect(scopeOf(r, key)).toBe("ALL");
  });

  it("maker-checker: the Admission Officer prepares and submits but can never approve", () => {
    expect(scopeOf("ADMISSION_OFFICER", "admission.create")).toBe("ALL");
    expect(scopeOf("ADMISSION_OFFICER", "student.document.manage")).toBe("ALL");
    expect(scopeOf("ADMISSION_OFFICER", "admission.approve")).toBeNull();
  });

  it("the Admission Officer receives no finance, payroll, sensitive-data or export permission", () => {
    const held = [...ctxFor("ADMISSION_OFFICER").permissions.keys()];
    expect(held.filter((k) => /^(fee|payroll|salary\.structure)\./.test(k))).toEqual([]);
    expect(held).not.toContain("student.sensitive.read");
    expect(held).not.toContain("employee.sensitive.read");
    expect(held).not.toContain("export.run");
    // Own salary slip (SELF) is the only salary-related grant, as for every staff role.
    expect(scopeOf("ADMISSION_OFFICER", "salary.self.read")).toBe("SELF");
  });

  it("teachers and the Accountant get no admission or document access (D8); teachers stay ASSIGNED for students", () => {
    for (const role of ["TEACHER", "CLASS_TEACHER", "ACCOUNTANT"]) {
      for (const key of ["admission.read", "admission.create", "admission.approve", "student.document.read", "student.document.manage"] as PermissionKey[]) {
        expect(scopeOf(role, key), `${role} ${key}`).toBeNull();
      }
    }
    expect(scopeOf("TEACHER", "student.read")).toBe("ASSIGNED");
    expect(scopeOf("CLASS_TEACHER", "student.read")).toBe("ASSIGNED");
    expect(scopeOf("ACCOUNTANT", "student.read")).toBe("ALL"); // existing grant kept (D8); fee lookup
  });

  it("parents and students get none of the new or admission permissions", () => {
    for (const role of ["PARENT", "STUDENT"]) {
      expect(holders("student.document.manage")).not.toContain(role);
      expect(holders("admission.read")).not.toContain(role);
    }
  });
});

describe("seed behaviour on an EXISTING database (honest gap)", () => {
  const plan = planSeed();
  it("the new permission student.document.manage reaches School Admin and Admission Officer through the new-permission rule", () => {
    const rows = newPermissionGrants(plan, ["student.document.manage"], new Set()).map((r) => `${r.roleKey}:${r.scope}`);
    expect(rows).toEqual(["SCHOOL_ADMIN:ALL", "ADMISSION_OFFICER:ALL"]);
  });
  it("Principal's admission.approve is an EXISTING permission, so the seed does not add it to an existing database", () => {
    // Existing grants of non-system roles are never changed by the seed (admin edits are kept). On
    // development it must be granted by a Super Admin in Roles (audited) or by an explicit, owner-approved step.
    const rows = newPermissionGrants(plan, ["student.document.manage"], new Set());
    expect(rows.some((r) => r.roleKey === "PRINCIPAL")).toBe(false);
    expect(newPermissionGrants(plan, [], new Set())).toEqual([]);
  });
});
