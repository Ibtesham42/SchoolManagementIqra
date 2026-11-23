import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountKindOf, accountLinkProblem, homePathFor, longSessionAllowed, portalRoleSetProblem } from "@/lib/rbac/account-kind";
import { buildPermissionMap, type AuthContext, type PortalContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { assertPortalStudent, portalVisibleChildren } from "@/lib/rbac/portal-access";
import { buildPortalContext, MAX_PORTAL_CHILDREN, portalGrantRows, type LoadedStudent } from "@/lib/auth/portal-context";
import { STAFF_SESSION_MS, LONG_SESSION_MS, staffBoundedSession } from "@/lib/auth/session";
import { childIdFromPath, portalNavItems } from "@/components/portal/portal-nav-items";
import { assertCanAssignRoles, assertRolesMatchLinks, type RoleGrants } from "@/modules/identity/identity.policy";
import { NotFoundError, ValidationError } from "@/lib/errors";

/** Phase 6A-M2 — account kinds (ADR-045), the portal context (ADR-044), redirects, the portal navigation and static guards. */

const window = { today: "2026-11-23", leaverAccessDays: 180 };

function roleCtx(roleKeys: string[], portal: PortalContext | null, extra: Partial<AuthContext> = {}): AuthContext {
  const rows = roleKeys.flatMap((roleKey) => {
    const role = ROLES.find((r) => r.key === roleKey)!;
    return role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  });
  return { userId: "u", username: "u", displayName: "U", roleKeys, sessionId: "s", isSuperAdmin: roleKeys.includes("SUPER_ADMIN"), permissions: buildPermissionMap(rows), portal, ...extra };
}

const child = (studentId: string, over: Partial<PortalContext["children"][number]> = {}) => ({ studentId, status: "ACTIVE" as const, leftOn: null, portalAccess: true, ...over });
const guardianPortal: PortalContext = { kind: "GUARDIAN", guardianId: "g1", studentId: null, children: [child("kid1"), child("kid2", { portalAccess: false })] };

describe("account kinds (ADR-045)", () => {
  it("only an exact {PARENT} / {STUDENT} role set is a portal account", () => {
    expect(accountKindOf(["PARENT"])).toBe("GUARDIAN");
    expect(accountKindOf(["STUDENT"])).toBe("STUDENT");
    expect(accountKindOf(["TEACHER"])).toBe("STAFF");
    expect(accountKindOf([])).toBe("STAFF");
    expect(accountKindOf(["PARENT", "TEACHER"])).toBe("STAFF");
    expect(accountKindOf(["PARENT", "STUDENT"])).toBe("STAFF");
  });

  it("mixed role sets are refused; staff-only and portal-only sets pass", () => {
    expect(portalRoleSetProblem(["PARENT", "TEACHER"])).toMatch(/can't be combined/);
    expect(portalRoleSetProblem(["PARENT", "STUDENT"])).toMatch(/can't be combined/);
    expect(portalRoleSetProblem(["STUDENT", "SUPER_ADMIN"])).toMatch(/can't be combined/);
    expect(portalRoleSetProblem(["PARENT"])).toBeNull();
    expect(portalRoleSetProblem(["PARENT", "PARENT"])).toBeNull();
    expect(portalRoleSetProblem(["TEACHER", "ACCOUNTANT"])).toBeNull();
    // The seed assigns only the Super Admin role (prisma/seed-core.ts) — a staff-only set.
    expect(portalRoleSetProblem(["SUPER_ADMIN"])).toBeNull();
  });

  it("person links fix the role set", () => {
    expect(accountLinkProblem(["PARENT"], { guardianId: "g" })).toBeNull();
    expect(accountLinkProblem(["TEACHER"], { guardianId: "g" })).toMatch(/only the Parent role/);
    expect(accountLinkProblem(["STUDENT"], { guardianId: "g" })).toMatch(/only the Parent role/);
    expect(accountLinkProblem([], { studentId: "s" })).toMatch(/only the Student role/);
    expect(accountLinkProblem(["STUDENT"], { studentId: "s" })).toBeNull();
    expect(accountLinkProblem(["PARENT"], { employeeId: "e" })).toMatch(/staff account/);
    expect(accountLinkProblem(["TEACHER"], { employeeId: "e" })).toBeNull();
  });

  it("redirect matrix: kind × pending password change", () => {
    expect(homePathFor("STAFF", false)).toBe("/erp");
    expect(homePathFor("STAFF", true)).toBe("/erp/change-password");
    expect(homePathFor("GUARDIAN", false)).toBe("/portal");
    expect(homePathFor("GUARDIAN", true)).toBe("/portal/change-password");
    expect(homePathFor("STUDENT", false)).toBe("/portal");
    expect(homePathFor("STUDENT", true)).toBe("/portal/change-password");
  });

  it("the 30-day session needs a portal-only account AND the tick; staff get 8 h even with it", () => {
    expect(longSessionAllowed(["PARENT"], true)).toBe(true);
    expect(longSessionAllowed(["STUDENT"], true)).toBe(true);
    expect(longSessionAllowed(["PARENT"], false)).toBe(false);
    expect(longSessionAllowed(["TEACHER"], true)).toBe(false);
    expect(longSessionAllowed(["SUPER_ADMIN"], true)).toBe(false);
    expect(longSessionAllowed(["PARENT", "TEACHER"], true)).toBe(false); // the old hazard: any portal role sufficed
  });

  it("identity refuses mixed role sets on create / update and roles that contradict the links", () => {
    const rolesByKey = new Map<string, RoleGrants>(ROLES.map((r) => [r.key, { key: r.key, isSystem: !!r.isSystem, permissions: r.grants.map(normalizeGrant) }]));
    const admin = roleCtx(["SUPER_ADMIN"], null);
    expect(() => assertCanAssignRoles(admin, null, ["PARENT", "TEACHER"], rolesByKey)).toThrow(ValidationError);
    expect(() => assertCanAssignRoles(admin, { id: "t", roleKeys: ["TEACHER"], isActive: true }, ["TEACHER", "STUDENT"], rolesByKey)).toThrow(ValidationError);
    expect(() => assertCanAssignRoles(admin, null, ["PARENT"], rolesByKey)).not.toThrow();
    expect(() => assertRolesMatchLinks(["TEACHER"], { guardianId: "g" })).toThrow(ValidationError);
    expect(() => assertRolesMatchLinks(["PARENT"], { employeeId: "e" })).toThrow(ValidationError);
  });
});

describe("portal context from the session lookup (ADR-044)", () => {
  const st = (id: string, over: Partial<LoadedStudent> = {}): LoadedStudent => ({ id, status: "ACTIVE", deletedAt: null, statusChanges: [], ...over });
  const base = { guardianId: null, studentId: null, guardian: null, student: null };

  it("staff and mixed accounts get no portal block", () => {
    expect(buildPortalContext({ ...base, roleKeys: ["TEACHER"] })).toBeNull();
    expect(buildPortalContext({ ...base, roleKeys: ["PARENT", "TEACHER"], guardianId: "g", guardian: { deletedAt: null, students: [{ portalAccess: true, student: st("k") }] } })).toBeNull();
  });

  it("a guardian's children carry status, leaving date and the block flag; deleted students drop out", () => {
    const ctx = buildPortalContext({
      ...base,
      roleKeys: ["PARENT"],
      guardianId: "g",
      guardian: {
        deletedAt: null,
        students: [
          { portalAccess: true, student: st("a") },
          { portalAccess: false, student: st("b") },
          { portalAccess: true, student: st("c", { status: "WITHDRAWN", statusChanges: [{ effectiveDate: new Date("2026-10-01T00:00:00Z") }] }) },
          { portalAccess: true, student: st("d", { deletedAt: new Date() }) },
        ],
      },
    });
    expect(ctx).toEqual({
      kind: "GUARDIAN",
      guardianId: "g",
      studentId: null,
      children: [
        { studentId: "a", status: "ACTIVE", leftOn: null, portalAccess: true },
        { studentId: "b", status: "ACTIVE", leftOn: null, portalAccess: false },
        { studentId: "c", status: "LEFT", leftOn: "2026-10-01", portalAccess: true },
      ],
    });
  });

  it("fails closed: no link, a deleted guardian or student → no children; at most MAX_PORTAL_CHILDREN", () => {
    expect(buildPortalContext({ ...base, roleKeys: ["PARENT"] })?.children).toEqual([]);
    expect(buildPortalContext({ ...base, roleKeys: ["PARENT"], guardianId: "g", guardian: { deletedAt: new Date(), students: [{ portalAccess: true, student: st("a") }] } })).toMatchObject({ guardianId: null, children: [] });
    expect(buildPortalContext({ ...base, roleKeys: ["STUDENT"], studentId: "s", student: st("s", { deletedAt: new Date() }) })).toMatchObject({ studentId: null, children: [] });
    expect(buildPortalContext({ ...base, roleKeys: ["STUDENT"], studentId: "s", student: st("s") })).toEqual({ kind: "STUDENT", guardianId: null, studentId: "s", children: [{ studentId: "s", status: "ACTIVE", leftOn: null, portalAccess: true }] });
    const many = Array.from({ length: MAX_PORTAL_CHILDREN + 1 }, (_, i) => ({ portalAccess: true, student: st(`k${i}`) }));
    expect(buildPortalContext({ ...base, roleKeys: ["PARENT"], guardianId: "g", guardian: { deletedAt: null, students: many } })?.children).toHaveLength(MAX_PORTAL_CHILDREN);
  });
});

describe("review 6A-M2 fixes", () => {
  it("M1: a staff session's idle lifetime is cut back to 8 h; a short one is left alone", () => {
    const lastSeenAt = new Date("2026-11-23T00:00:00Z");
    const long = { lastSeenAt, expiresAt: new Date(lastSeenAt.getTime() + LONG_SESSION_MS) };
    expect(staffBoundedSession(long).expiresAt.getTime()).toBe(lastSeenAt.getTime() + STAFF_SESSION_MS);
    const short = { lastSeenAt, expiresAt: new Date(lastSeenAt.getTime() + STAFF_SESSION_MS) };
    expect(staffBoundedSession(short)).toBe(short);
  });

  it("L1: a portal account keeps only allowlisted grants at its own portal scope", () => {
    const row = (permissionKey: string, scope: "ALL" | "CHILDREN" | "SELF" | "ASSIGNED") => ({ roleKey: "PARENT", isSystem: false, permissionKey, scope });
    const rows = [row("fee.read", "CHILDREN"), row("fee.read", "ALL"), row("student.read", "SELF"), row("employee.read", "CHILDREN"), row("fee.pay.online", "CHILDREN")];
    expect(portalGrantRows(rows, "GUARDIAN").map((r) => `${r.permissionKey}:${r.scope}`)).toEqual(["fee.read:CHILDREN", "fee.pay.online:CHILDREN"]);
    expect(portalGrantRows(rows, "STUDENT").map((r) => `${r.permissionKey}:${r.scope}`)).toEqual(["student.read:SELF"]);
  });

  it("L1: the catalog's own PARENT / STUDENT grants all survive the filter", () => {
    for (const [key, kind] of [["PARENT", "GUARDIAN"], ["STUDENT", "STUDENT"]] as const) {
      const role = ROLES.find((r) => r.key === key)!;
      const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey: key, isSystem: false, permissionKey: g.key, scope: g.scope }));
      expect(portalGrantRows(rows, kind)).toHaveLength(rows.length);
    }
  });
});

describe("assertPortalStudent (scope membership, identical NotFound)", () => {
  it("a parent sees an own, unblocked child only", () => {
    const ctx = roleCtx(["PARENT"], guardianPortal);
    expect(() => assertPortalStudent(ctx, "kid1", "profile", window)).not.toThrow();
    for (const id of ["kid2", "other-family", "nonexistent"]) expect(() => assertPortalStudent(ctx, id, "profile", window)).toThrow(NotFoundError);
    expect(portalVisibleChildren(ctx, window).map((c) => c.studentId)).toEqual(["kid1"]);
  });

  it("staff and Super Admin contexts never pass a portal check (they have no portal block)", () => {
    expect(() => assertPortalStudent(roleCtx(["SUPER_ADMIN"], null), "kid1", "profile", window)).toThrow(NotFoundError);
    expect(() => assertPortalStudent(roleCtx(["PRINCIPAL"], null), "kid1", "profile", window)).toThrow(NotFoundError);
    // A Super Admin with a forged portal block still fails: membership is checked, not the widest scope.
    expect(() => assertPortalStudent(roleCtx(["SUPER_ADMIN"], guardianPortal), "kid1", "profile", window)).toThrow(NotFoundError);
  });

  it("the portal kind must match the scope held (a student context with CHILDREN grants fails)", () => {
    const ctx = roleCtx(["PARENT"], { kind: "STUDENT", guardianId: null, studentId: "kid1", children: [child("kid1")] });
    expect(() => assertPortalStudent(ctx, "kid1", "profile", window)).toThrow(NotFoundError);
  });

  it("a pending password change refuses before any record check", () => {
    const ctx = roleCtx(["PARENT"], guardianPortal, { mustChangePassword: true });
    expect(() => assertPortalStudent(ctx, "kid1", "profile", window)).toThrow(/change your password/);
  });
});

describe("portal navigation", () => {
  it("offers only /portal links; the child comes from the path only when it is the account's own", () => {
    expect(childIdFromPath("/portal/c/kid1/profile", ["kid1"])).toBe("kid1");
    expect(childIdFromPath("/portal/c/kid9/profile", ["kid1"])).toBeNull();
    expect(childIdFromPath("/portal/c/%E0%A4/profile", ["kid1"])).toBeNull();
    expect(childIdFromPath("/portal", ["kid1"])).toBeNull();
    for (const id of [null, "kid1"]) for (const item of portalNavItems(id)) expect(item.href.startsWith("/portal")).toBe(true);
    expect(portalNavItems("kid1").map((i) => i.label)).toEqual(["Home", "Profile", "Account"]);
  });
});

// ── static guards ──
const ROOT = join(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("static guards (ADR-045)", () => {
  const portalFiles = [...walk(join(ROOT, "src", "app", "portal")), ...walk(join(ROOT, "src", "components", "portal"))];

  it("the portal never imports the ERP navigation", () => {
    for (const f of portalFiles) expect(readFileSync(f, "utf8"), f).not.toMatch(/components\/erp\/(erp-nav|nav-items)/);
  });

  it("every portal page and the layout call requirePortal; portal actions too", () => {
    const entries = portalFiles.filter((f) => /[\\/](page|layout)\.tsx$/.test(f) || /[\\/]actions\.ts$/.test(f));
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const f of entries) expect(readFileSync(f, "utf8"), f).toMatch(/requirePortal\(/);
  });

  it("every exported read in students.portal.ts runs the portal check", () => {
    const src = readFileSync(join(ROOT, "src", "modules", "students", "students.portal.ts"), "utf8");
    const bodies = src.split(/\nexport async function /).slice(1);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      if (name === "portalWindow") continue; // settings only, no student data
      expect(body, name).toMatch(/assertPortalStudent\(|portalVisibleChildren\(/);
    }
  });

  it("requireAuth sends portal accounts away from the ERP; login uses the long-session rule", () => {
    const context = readFileSync(join(ROOT, "src", "lib", "auth", "context.ts"), "utf8");
    expect(context).toMatch(/if \(ctx\.portal && !opts\.allowPortal\) redirect\(homePath\(ctx\)\)/);
    const auth = readFileSync(join(ROOT, "src", "modules", "identity", "auth.service.ts"), "utf8");
    expect(auth).toMatch(/longSessionAllowed\(roleKeys, input\.remember\)/);
    expect(auth).not.toMatch(/LONG_SESSION_ROLES/);
  });
});
