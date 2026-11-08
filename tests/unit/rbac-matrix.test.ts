import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authorize, buildPermissionMap, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { ALL_PERMISSION_KEYS, ROLES, normalizeGrant } from "@/lib/rbac/catalog";
import { defaultGrantMatrix, renderMatrixMarkdown } from "@/lib/rbac/matrix";
import { ForbiddenError } from "@/lib/errors";
import { pickClientIp } from "@/lib/auth/client-ip";

function ctxFor(roleKey: string, extra: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map((g) => {
    const { key, scope } = normalizeGrant(g);
    return { roleKey, isSystem: !!role.isSystem, permissionKey: key, scope };
  });
  return {
    userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s",
    isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), ...extra,
  };
}

describe("full RBAC matrix — 13 roles × 79 permissions", () => {
  it("catalog has 13 roles and 79 permissions", () => {
    expect(ROLES).toHaveLength(13);
    expect(ALL_PERMISSION_KEYS).toHaveLength(79);
  });

  it("docs/RBAC_MATRIX.md is up to date with the code", () => {
    const onDisk = readFileSync(new URL("../../docs/RBAC_MATRIX.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(onDisk).toBe(renderMatrixMarkdown());
  });

  // Every one of the 13 × 79 = 1,027 cells: authorize() must agree exactly with the declared grant.
  const matrix = defaultGrantMatrix();
  describe.each(ROLES.map((r) => r.key))("%s", (roleKey) => {
    const ctx = ctxFor(roleKey);
    it.each(ALL_PERMISSION_KEYS)("%s", (perm) => {
      const declared = roleKey === "SUPER_ADMIN" ? "ALL" : matrix.get(roleKey)?.get(perm);
      if (declared) expect(authorize(ctx, perm)).toBe(declared);
      else expect(() => authorize(ctx, perm)).toThrow(ForbiddenError);
    });
  });
});

describe("data isolation invariants (permission level)", () => {
  const holders = (perm: (typeof ALL_PERMISSION_KEYS)[number]) =>
    ROLES.filter((r) => ctxFor(r.key).permissions.has(perm) || r.key === "SUPER_ADMIN");

  it("parents only ever hold CHILDREN-scoped or non-record permissions", () => {
    for (const [perm, scopes] of ctxFor("PARENT").permissions) {
      if (perm !== "notice.read") expect([...scopes]).toEqual(["CHILDREN"]);
    }
  });
  it("students only ever hold SELF-scoped or non-record permissions", () => {
    for (const [perm, scopes] of ctxFor("STUDENT").permissions) {
      if (perm !== "notice.read") expect([...scopes]).toEqual(["SELF"]);
    }
  });
  it("parents and students hold no write permission at all", () => {
    for (const role of ["PARENT", "STUDENT"]) {
      const writes = [...ctxFor(role).permissions.keys()].filter((k) => !/\.(read|pay\.online)$/.test(k));
      expect(writes).toEqual([]);
    }
  });
  it("salary data: only Super Admin, Principal, Accountant, HR can read payroll; everyone else at most SELF", () => {
    expect(holders("payroll.read").map((r) => r.key).sort()).toEqual(["ACCOUNTANT", "HR_MANAGER", "PRINCIPAL", "SUPER_ADMIN"]);
    for (const r of ROLES) {
      const s = ctxFor(r.key).permissions.get("salary.self.read");
      if (s && r.key !== "SUPER_ADMIN") expect([...s]).toEqual(["SELF"]);
    }
  });
  it("financial write operations are limited to finance roles", () => {
    for (const perm of ["fee.collect", "fee.refund", "fee.structure.manage", "payroll.pay", "payroll.prepare"] as const) {
      const keys = holders(perm).map((r) => r.key);
      expect(keys.every((k) => ["SUPER_ADMIN", "ACCOUNTANT", "HR_MANAGER"].includes(k))).toBe(true);
    }
  });
  it("payroll approval cannot be held by the preparing roles (maker-checker at role level)", () => {
    for (const r of holders("payroll.prepare")) {
      if (r.key !== "SUPER_ADMIN") expect(ctxFor(r.key).permissions.has("payroll.approve")).toBe(false);
    }
  });
  it("teachers' student access is ASSIGNED-only", () => {
    for (const role of ["TEACHER", "CLASS_TEACHER"]) {
      expect([...ctxFor(role).permissions.get("student.read")!]).toEqual(["ASSIGNED"]);
    }
  });
});

describe("forced password change blocks every permissioned operation", () => {
  it("authorize throws and hasPermission is false, even for Super Admin", () => {
    const ctx = ctxFor("SUPER_ADMIN", { mustChangePassword: true });
    expect(() => authorize(ctx, "student.read")).toThrow(/change your password/);
    expect(hasPermission(ctx, "role.manage")).toBe(false);
  });
});

describe("client IP selection for rate limiting", () => {
  it("ignores spoofed leftmost X-Forwarded-For entries", () => {
    expect(pickClientIp("6.6.6.6, 203.0.113.9", null, 1)).toBe("203.0.113.9");
    expect(pickClientIp("6.6.6.6, 198.51.100.2, 203.0.113.9", null, 2)).toBe("198.51.100.2");
  });
  it("falls back to x-real-ip, then 'unknown'", () => {
    expect(pickClientIp(null, "192.0.2.4", 1)).toBe("192.0.2.4");
    expect(pickClientIp(null, null, 1)).toBe("unknown");
  });
});
