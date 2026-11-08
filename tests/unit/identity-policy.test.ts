import { describe, expect, it } from "vitest";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { ROLES, normalizeGrant, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  actorCovers,
  assertCanAssignRoles,
  assertCanDeactivate,
  assertCanDeleteRole,
  assertCanEditRole,
  assertCanModifyUser,
  assertGrantsWithinActor,
  assertKeepsASuperAdmin,
  assertValidNewRoleKey,
  type RoleGrants,
} from "@/modules/identity/identity.policy";

function ctx(roleKeys: string[], extraGrants: [PermissionKey, Scope][] = [], userId = "actor"): AuthContext {
  const rows = ROLES.filter((r) => roleKeys.includes(r.key)).flatMap((r) =>
    r.grants.map((g) => ({ roleKey: r.key, isSystem: !!r.isSystem, permissionKey: normalizeGrant(g).key, scope: normalizeGrant(g).scope })),
  );
  for (const [k, s] of extraGrants) rows.push({ roleKey: "CUSTOM", isSystem: false, permissionKey: k, scope: s });
  return {
    userId, username: "a", displayName: "A", sessionId: "s", roleKeys,
    isSuperAdmin: roleKeys.includes("SUPER_ADMIN"), permissions: buildPermissionMap(rows),
  };
}

const rolesByKey = new Map<string, RoleGrants>(
  ROLES.map((r) => [r.key, { key: r.key, isSystem: !!r.isSystem, permissions: r.grants.map(normalizeGrant) }]),
);

const superAdmin = ctx(["SUPER_ADMIN"]);
// A School Admin whom the Super Admin has additionally trusted with user.manage.
const delegatedAdmin = ctx(["SCHOOL_ADMIN"], [["user.manage", "ALL"], ["role.manage", "ALL"]]);
const teacher = ctx(["TEACHER"]);

// Targets carry their effective permissions (as the service loads them), so coverage checks apply.
const target = (roleKeys: string[], id = "target", isActive = true) => ({
  id,
  roleKeys,
  isActive,
  permissions: roleKeys.flatMap((k) => rolesByKey.get(k)?.permissions ?? []),
});

describe("user administration — Super Admin protections", () => {
  it("requires user.manage", () => {
    expect(() => assertCanModifyUser(teacher, target(["TEACHER"]))).toThrow(ForbiddenError);
    expect(() => assertCanModifyUser(ctx(["SCHOOL_ADMIN"]), target(["TEACHER"]))).toThrow(ForbiddenError); // user.read only
  });
  it("only a Super Admin can modify a Super Admin account", () => {
    expect(() => assertCanModifyUser(delegatedAdmin, target(["SUPER_ADMIN"]))).toThrow(/Only a Super Admin/);
    expect(() => assertCanModifyUser(superAdmin, target(["SUPER_ADMIN"]))).not.toThrow();
    expect(() => assertCanModifyUser(delegatedAdmin, target([]))).not.toThrow(); // no permissions → nothing to escalate to
  });
  it("delegated School Admin cannot take over a Teacher account (would gain marks.enter / attendance marking)", () => {
    expect(() => assertCanModifyUser(delegatedAdmin, target(["TEACHER"]))).toThrow(/permissions you also hold/);
  });
  it("only a Super Admin can grant or remove the Super Admin role", () => {
    expect(() => assertCanAssignRoles(delegatedAdmin, target(["TEACHER"]), ["TEACHER", "SUPER_ADMIN"], rolesByKey)).toThrow(/Super Admin role/);
    expect(() => assertCanAssignRoles(delegatedAdmin, null, ["SUPER_ADMIN"], rolesByKey)).toThrow(/Super Admin role/);
    expect(() => assertCanAssignRoles(superAdmin, target(["TEACHER"]), ["SUPER_ADMIN"], rolesByKey)).not.toThrow();
  });
  it("a Super Admin cannot remove the role from their own account", () => {
    expect(() => assertCanAssignRoles(superAdmin, target(["SUPER_ADMIN"], "actor"), [], rolesByKey)).toThrow(/your own account/);
  });
  it("users cannot deactivate themselves", () => {
    expect(() => assertCanDeactivate(superAdmin, target(["SUPER_ADMIN"], "actor"))).toThrow(/your own account/);
  });
  it("the last active Super Admin must remain", () => {
    expect(() => assertKeepsASuperAdmin(["sa1"], "sa1", { isActive: false, isSuperAdmin: true })).toThrow(/At least one/);
    expect(() => assertKeepsASuperAdmin(["sa1"], "sa1", { isActive: true, isSuperAdmin: false })).toThrow(/At least one/);
    expect(() => assertKeepsASuperAdmin(["sa1", "sa2"], "sa1", { isActive: false, isSuperAdmin: true })).not.toThrow();
  });
  it("rejects unknown roles", () => {
    expect(() => assertCanAssignRoles(superAdmin, null, ["NOPE_ROLE"], rolesByKey)).toThrow(ValidationError);
  });
});

describe("anti-escalation for delegated administrators", () => {
  it("cannot assign a role that grants permissions they don't hold", () => {
    // School Admin lacks payroll.* → can't hand out Accountant.
    expect(() => assertCanAssignRoles(delegatedAdmin, target([]), ["ACCOUNTANT"], rolesByKey)).toThrow(/permissions you do not hold/);
    // Nor remove it (could be used to disrupt finance staff).
    expect(() => assertCanAssignRoles(delegatedAdmin, target(["ACCOUNTANT"]), [], rolesByKey)).toThrow(/permissions you do not hold/);
  });
  it("can assign roles fully covered by their own permissions", () => {
    // Parent role: student.read [CHILDREN] etc. — School Admin holds student.read ALL, fee.read ALL… but not fee.pay.online.
    expect(() => assertCanAssignRoles(delegatedAdmin, target([]), ["PARENT"], rolesByKey)).toThrow();
    const covering = ctx(["SCHOOL_ADMIN"], [["user.manage", "ALL"], ["fee.pay.online", "ALL"], ["result.read", "ALL"]]);
    expect(() => assertCanAssignRoles(covering, target([]), ["PARENT"], rolesByKey)).not.toThrow();
  });
  it("scope matters: ASSIGNED does not cover ALL", () => {
    const narrow = ctx([], [["user.manage", "ALL"], ["student.read", "ASSIGNED"]]);
    expect(actorCovers(narrow, "student.read", "ASSIGNED")).toBe(true);
    expect(actorCovers(narrow, "student.read", "SELF")).toBe(true);
    expect(actorCovers(narrow, "student.read", "ALL")).toBe(false);
  });
  it("cannot grant permissions beyond their own when editing a role", () => {
    expect(() => assertGrantsWithinActor(delegatedAdmin, [], [{ key: "payroll.read", scope: "ALL" }])).toThrow(/payroll.read/);
    expect(() => assertGrantsWithinActor(delegatedAdmin, [], [{ key: "student.read", scope: "ALL" }])).not.toThrow();
    // Unchanged grants they don't hold are fine (they're not touching them).
    const current = [{ key: "payroll.read" as const, scope: "ALL" as const }];
    expect(() => assertGrantsWithinActor(delegatedAdmin, current, [...current, { key: "student.read", scope: "ALL" }])).not.toThrow();
    // …but revoking them is not.
    expect(() => assertGrantsWithinActor(delegatedAdmin, current, [])).toThrow(/payroll.read/);
  });
  it("Super Admin may grant anything", () => {
    expect(() => assertGrantsWithinActor(superAdmin, [], [{ key: "backup.manage", scope: "ALL" }])).not.toThrow();
  });
});

describe("role administration", () => {
  it("system roles (Super Admin) are immutable for everyone", () => {
    expect(() => assertCanEditRole(superAdmin, { key: "SUPER_ADMIN", isSystem: true })).toThrow(/System roles/);
    expect(() => assertCanEditRole(superAdmin, { key: "SUPER_ADMIN", isSystem: false })).toThrow(/System roles/);
    expect(() => assertCanDeleteRole(superAdmin, { key: "SUPER_ADMIN", isSystem: true, userCount: 0 })).toThrow(/System roles/);
  });
  it("delegated admins cannot edit a role they hold", () => {
    expect(() => assertCanEditRole(delegatedAdmin, { key: "SCHOOL_ADMIN", isSystem: false })).toThrow(/role you hold/);
    expect(() => assertCanEditRole(delegatedAdmin, { key: "LIBRARIAN", isSystem: false })).not.toThrow();
  });
  it("requires role.manage", () => {
    expect(() => assertCanEditRole(teacher, { key: "LIBRARIAN", isSystem: false })).toThrow(ForbiddenError);
  });
  it("roles in use cannot be deleted", () => {
    expect(() => assertCanDeleteRole(superAdmin, { key: "LIBRARIAN", isSystem: false, userCount: 2 })).toThrow(/Remove this role/);
    expect(() => assertCanDeleteRole(superAdmin, { key: "LIBRARIAN", isSystem: false, userCount: 0 })).not.toThrow();
  });
  it("validates new role keys and blocks SUPER_ADMIN / duplicates", () => {
    expect(() => assertValidNewRoleKey("EXAM_COORDINATOR", new Set())).not.toThrow();
    for (const bad of ["ab", "lowercase", "1ROLE", "HAS-DASH", "X".repeat(41)]) {
      expect(() => assertValidNewRoleKey(bad, new Set())).toThrow(ValidationError);
    }
    expect(() => assertValidNewRoleKey("SUPER_ADMIN", new Set())).toThrow(/already exists/);
    expect(() => assertValidNewRoleKey("LIBRARIAN", new Set(["LIBRARIAN"]))).toThrow(/already exists/);
  });
});

describe("forced password change blocks administration", () => {
  it("even a Super Admin with a pending change cannot modify users", () => {
    const pending = { ...superAdmin, mustChangePassword: true };
    expect(() => assertCanModifyUser(pending, target(["TEACHER"]))).toThrow(ForbiddenError);
    expect(() => assertCanEditRole(pending, { key: "LIBRARIAN", isSystem: false })).toThrow(ForbiddenError);
  });
});
