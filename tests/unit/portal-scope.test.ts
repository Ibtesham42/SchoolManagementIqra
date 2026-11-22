import { describe, expect, it } from "vitest";
import { buildPermissionMap, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { PORTAL_PERMISSION, portalCanSee, visibleChildren, type PortalCapability, type PortalFamily } from "@/lib/rbac/portal-scope";
import { readPortalSettings } from "@/modules/settings/settings.schemas";

/** Phase 6A-M1: the portal family policy (truth table), catalog invariants for portal roles, portal settings. */

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap(rows) };
}
const scopes = (roleKey: string) => {
  const ctx = roleCtx(roleKey);
  return (k: PermissionKey): Scope | null => (ctx.permissions.has(k) ? scopeFor(ctx, k) : null);
};
const parent = scopes("PARENT");
const student = scopes("STUDENT");
const ALL_CAPS = Object.keys(PORTAL_PERMISSION) as PortalCapability[];
const window = { today: "2026-11-22", leaverAccessDays: 180 };

const family: PortalFamily = {
  kind: "GUARDIAN",
  children: [
    { studentId: "kid1", status: "ACTIVE", leftOn: null, portalAccess: true },
    { studentId: "kid2", status: "ACTIVE", leftOn: null, portalAccess: false }, // P24 blocked
    { studentId: "kid3", status: "LEFT", leftOn: "2026-10-01", portalAccess: true }, // 52 days ago
    { studentId: "kid4", status: "LEFT", leftOn: "2025-01-01", portalAccess: true }, // long gone
  ],
};

describe("portal family policy (truth table)", () => {
  it("a guardian sees every capability of an active linked child, nothing of anyone else", () => {
    for (const cap of ALL_CAPS) {
      expect(portalCanSee(family, parent, "kid1", cap, window), cap).toBe(true);
      expect(portalCanSee(family, parent, "stranger", cap, window), cap).toBe(false);
    }
  });
  it("P24: a blocked link shows nothing", () => {
    for (const cap of ALL_CAPS) expect(portalCanSee(family, parent, "kid2", cap, window), cap).toBe(false);
  });
  it("P17: a leaver within the window keeps results and fees only; after it, nothing; 0 days = nothing", () => {
    for (const cap of ALL_CAPS) expect(portalCanSee(family, parent, "kid3", cap, window), cap).toBe(cap === "results" || cap === "fees");
    for (const cap of ALL_CAPS) expect(portalCanSee(family, parent, "kid4", cap, window), cap).toBe(false);
    expect(portalCanSee(family, parent, "kid3", "results", { ...window, leaverAccessDays: 0 })).toBe(false);
    expect(portalCanSee(family, parent, "kid3", "results", { ...window, leaverAccessDays: 52 })).toBe(true);
    expect(portalCanSee(family, parent, "kid3", "results", { ...window, leaverAccessDays: 51 })).toBe(false);
  });
  it("a student sees only itself and never fees (P14, P16)", () => {
    const self: PortalFamily = { kind: "STUDENT", children: [{ studentId: "me", status: "ACTIVE", leftOn: null, portalAccess: true }] };
    for (const cap of ALL_CAPS) expect(portalCanSee(self, student, "me", cap, window), cap).toBe(cap !== "fees");
    expect(portalCanSee(self, student, "sibling", "profile", window)).toBe(false);
  });
  it("the scope must be CHILDREN for a guardian and SELF for a student — staff scopes never pass", () => {
    const allScope = () => "ALL" as Scope;
    expect(portalCanSee(family, allScope, "kid1", "profile", window)).toBe(false);
    const childScope = () => "CHILDREN" as Scope;
    const self: PortalFamily = { kind: "STUDENT", children: [{ studentId: "me", status: "ACTIVE", leftOn: null, portalAccess: true }] };
    expect(portalCanSee(self, childScope, "me", "profile", window)).toBe(false);
    expect(portalCanSee(family, () => null, "kid1", "profile", window)).toBe(false);
  });
  it("the child switcher lists active and in-window leavers, not blocked or long-gone ones", () => {
    expect(visibleChildren(family, parent, window).map((c) => c.studentId)).toEqual(["kid1", "kid3"]);
  });
});

describe("catalog invariants for portal roles (P16)", () => {
  const portal = ROLES.filter((r) => r.key === "PARENT" || r.key === "STUDENT");
  it("no portal role holds an ALL or ASSIGNED grant", () => {
    for (const r of portal) for (const g of r.grants.map(normalizeGrant)) expect(["CHILDREN", "SELF"], `${r.key} ${g.key}`).toContain(g.scope);
  });
  it("Parent uses CHILDREN only, Student SELF only", () => {
    for (const g of portal.find((r) => r.key === "PARENT")!.grants.map(normalizeGrant)) expect(g.scope, g.key).toBe("CHILDREN");
    for (const g of portal.find((r) => r.key === "STUDENT")!.grants.map(normalizeGrant)) expect(g.scope, g.key).toBe("SELF");
  });
  it("no write permission for families except the payment claim", () => {
    const reads = /\.read$/;
    for (const r of portal) for (const g of r.grants.map(normalizeGrant)) if (!reads.test(g.key)) expect(g.key, r.key).toBe("fee.pay.online");
  });
  it("students don't see fees; every capability's permission is granted to the Parent", () => {
    expect(portal.find((r) => r.key === "STUDENT")!.grants.map(normalizeGrant).some((g) => g.key === "fee.read")).toBe(false);
    for (const cap of ALL_CAPS) expect(parent(PORTAL_PERMISSION[cap]), cap).toBe("CHILDREN");
  });
});

describe("portal settings (school_setting.features.portal)", () => {
  it("safe defaults when missing or invalid", () => {
    const d = { studentAccounts: false, studentMinClassLevel: 9, leaverAccessDays: 180, upi: null, privacyNoticeVersion: null };
    expect(readPortalSettings(null)).toEqual(d);
    expect(readPortalSettings({ portal: { studentAccounts: "yes" } })).toEqual(d);
    expect(readPortalSettings({ portal: { leaverAccessDays: 999 } })).toEqual(d);
  });
  it("reads a valid block; UPI IDs are checked and lower-cased", () => {
    expect(readPortalSettings({ portal: { studentAccounts: true, studentMinClassLevel: 10, upi: { payeeName: "Demo Public School", vpa: "Demo.School@okbank" } } })).toMatchObject({ studentAccounts: true, studentMinClassLevel: 10, upi: { vpa: "demo.school@okbank" } });
    expect(readPortalSettings({ portal: { upi: { payeeName: "Demo", vpa: "not-a-vpa" } } }).upi).toBeNull();
  });
});
