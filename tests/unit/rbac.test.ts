import { describe, expect, it } from "vitest";
import { authorize, buildPermissionMap, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { ALL_PERMISSION_KEYS, ROLES, normalizeGrant, type PermissionKey } from "@/lib/rbac/catalog";
import { ForbiddenError, UnauthenticatedError } from "@/lib/errors";

function ctxFor(roleKeys: string[]): AuthContext {
  const rows = ROLES.filter((r) => roleKeys.includes(r.key)).flatMap((r) =>
    r.grants.map((g) => {
      const { key, scope } = normalizeGrant(g);
      return { roleKey: r.key, isSystem: !!r.isSystem, permissionKey: key, scope };
    }),
  );
  return {
    userId: "u1",
    username: "u",
    displayName: "U",
    roleKeys,
    sessionId: "s1",
    isSuperAdmin: roleKeys.includes("SUPER_ADMIN"),
    permissions: buildPermissionMap(rows),
  };
}

describe("role catalog", () => {
  it("defines all 13 required roles", () => {
    expect(ROLES.map((r) => r.key).sort()).toEqual(
      [
        "ACCOUNTANT", "ADMISSION_OFFICER", "CLASS_TEACHER", "HR_MANAGER", "LIBRARIAN", "PARENT", "PRINCIPAL",
        "SCHOOL_ADMIN", "STUDENT", "SUPER_ADMIN", "TEACHER", "TRANSPORT_MANAGER", "VICE_PRINCIPAL",
      ].sort(),
    );
  });
  it("only references permissions that exist", () => {
    const valid = new Set<string>(ALL_PERMISSION_KEYS);
    for (const role of ROLES) for (const g of role.grants) expect(valid.has(normalizeGrant(g).key)).toBe(true);
  });
  it("Super Admin is the only system role and holds every permission", () => {
    expect(ROLES.filter((r) => r.isSystem).map((r) => r.key)).toEqual(["SUPER_ADMIN"]);
    expect(ROLES.find((r) => r.key === "SUPER_ADMIN")!.grants).toHaveLength(ALL_PERMISSION_KEYS.length);
  });
});

describe("authorize", () => {
  it("rejects anonymous callers with 401", () => {
    expect(() => authorize(null, "student.read")).toThrow(UnauthenticatedError);
  });
  it("Super Admin passes everything with ALL scope", () => {
    const ctx = ctxFor(["SUPER_ADMIN"]);
    for (const key of ALL_PERMISSION_KEYS) expect(authorize(ctx, key)).toBe("ALL");
  });

  // Sensitive-permission matrix: [permission, roles that may hold it]. Every other role must get 403.
  const MATRIX: [PermissionKey, string[]][] = [
    ["student.sensitive.read", ["SUPER_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL"]],
    ["employee.sensitive.read", ["SUPER_ADMIN", "HR_MANAGER"]],
    ["payroll.read", ["SUPER_ADMIN", "PRINCIPAL", "ACCOUNTANT", "HR_MANAGER"]],
    ["payroll.approve", ["SUPER_ADMIN", "PRINCIPAL"]],
    ["role.manage", ["SUPER_ADMIN"]],
    ["user.manage", ["SUPER_ADMIN"]],
    ["audit.read", ["SUPER_ADMIN", "PRINCIPAL"]],
    ["backup.manage", ["SUPER_ADMIN"]],
    ["chatbot.manage", ["SUPER_ADMIN"]],
    ["rollnumber.finalize", ["SUPER_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL"]],
    ["fee.refund", ["SUPER_ADMIN", "ACCOUNTANT"]],
  ];
  describe.each(MATRIX)("%s", (permission, allowed) => {
    it.each(ROLES.map((r) => r.key))("%s", (role) => {
      const ctx = ctxFor([role]);
      if (allowed.includes(role)) expect(authorize(ctx, permission)).toBeTruthy();
      else expect(() => authorize(ctx, permission)).toThrow(ForbiddenError);
    });
  });

  it("teachers get ASSIGNED scope, parents CHILDREN, students SELF", () => {
    expect(scopeFor(ctxFor(["TEACHER"]), "student.read")).toBe("ASSIGNED");
    expect(scopeFor(ctxFor(["PARENT"]), "student.read")).toBe("CHILDREN");
    expect(scopeFor(ctxFor(["STUDENT"]), "student.read")).toBe("SELF");
    expect(scopeFor(ctxFor(["TEACHER"]), "salary.self.read")).toBe("SELF");
  });
  it("multiple roles union and the widest scope wins", () => {
    const ctx = ctxFor(["TEACHER", "ADMISSION_OFFICER"]);
    expect(scopeFor(ctx, "student.read")).toBe("ALL");
    expect(hasPermission(ctx, "admission.create")).toBe(true);
  });
  it("teachers cannot see other people's salaries", () => {
    expect(hasPermission(ctxFor(["TEACHER"]), "payroll.read")).toBe(false);
  });
});
