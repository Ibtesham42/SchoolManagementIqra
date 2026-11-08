import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { ROLES, normalizeGrant, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { ForbiddenError } from "@/lib/errors";
import { ABSOLUTE_SESSION_MS, LONG_SESSION_MS, STAFF_SESSION_MS, nextSessionExpiry, sessionCookieName } from "@/lib/auth/session";
import { buildCsp, createNonce } from "@/lib/csp";
import { bucketKey, RULES } from "@/lib/rate-limit";
import { redact } from "@/lib/audit";
import { actorCovers, assertCanModifyUser, scopeCovers } from "@/modules/identity/identity.policy";

// ─── mocked DB for the school-name cache (no database access in unit tests) ───
const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({ prisma: { schoolSetting: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));

function ctx(grants: [PermissionKey, Scope][], opts: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "actor", username: "a", displayName: "A", sessionId: "s", roleKeys: ["CUSTOM"], isSuperAdmin: false,
    permissions: buildPermissionMap(grants.map(([k, s]) => ({ roleKey: "CUSTOM", isSystem: false, permissionKey: k, scope: s }))),
    ...opts,
  };
}
const grantsOf = (roleKey: string) => ROLES.find((r) => r.key === roleKey)!.grants.map(normalizeGrant);

describe("H — scope partial order", () => {
  it("ALL covers everything; a scope covers itself and SELF; ASSIGNED and CHILDREN don't cover each other", () => {
    expect(scopeCovers("ALL", "CHILDREN")).toBe(true);
    expect(scopeCovers("ASSIGNED", "ASSIGNED")).toBe(true);
    expect(scopeCovers("ASSIGNED", "SELF")).toBe(true);
    expect(scopeCovers("ASSIGNED", "CHILDREN")).toBe(false);
    expect(scopeCovers("CHILDREN", "ASSIGNED")).toBe(false);
    expect(scopeCovers("SELF", "ASSIGNED")).toBe(false);
    expect(scopeCovers("ASSIGNED", "ALL")).toBe(false);
  });
  it("a teacher-scoped actor can't hand out parent (CHILDREN) access", () => {
    const t = ctx([["student.read", "ASSIGNED"]]);
    expect(actorCovers(t, "student.read", "CHILDREN")).toBe(false);
  });
});

describe("B — delegated admins can't take over more-privileged accounts", () => {
  const delegated = ctx([["user.manage", "ALL"], ["user.read", "ALL"], ["student.read", "ALL"], ["library.read", "ALL"], ["library.manage", "ALL"], ["library.issue", "ALL"], ["employee.read", "ALL"], ["leave.request", "ALL"], ["salary.self.read", "SELF"], ["notice.read", "ALL"]]);
  it("denies modifying a Principal (holds payroll.approve) — e.g. password reset → sign in as them", () => {
    expect(() => assertCanModifyUser(delegated, { id: "p", roleKeys: ["PRINCIPAL"], isActive: true, permissions: grantsOf("PRINCIPAL") })).toThrow(
      /permissions you also hold/,
    );
  });
  it("allows modifying a user whose permissions are all covered (Librarian)", () => {
    expect(() => assertCanModifyUser(delegated, { id: "l", roleKeys: ["LIBRARIAN"], isActive: true, permissions: grantsOf("LIBRARIAN") })).not.toThrow();
  });
  it("fails closed when the target's permissions weren't loaded", () => {
    expect(() => assertCanModifyUser(delegated, { id: "x", roleKeys: ["LIBRARIAN"], isActive: true })).toThrow(ForbiddenError);
  });
  it("Super Admin is unaffected; self-service on own account is allowed", () => {
    const sa = ctx([], { isSuperAdmin: true, roleKeys: ["SUPER_ADMIN"] });
    expect(() => assertCanModifyUser(sa, { id: "p", roleKeys: ["PRINCIPAL"], isActive: true, permissions: grantsOf("PRINCIPAL") })).not.toThrow();
    expect(() => assertCanModifyUser(delegated, { id: "actor", roleKeys: ["CUSTOM"], isActive: true, permissions: [{ key: "backup.manage", scope: "ALL" }] })).not.toThrow();
  });
});

describe("D — session renewal never extends beyond its idle lifetime or the absolute cap", () => {
  const H = 3600_000;
  const t0 = Date.UTC(2026, 10, 8, 8, 0, 0);
  it("no renewal while more than half the idle lifetime remains", () => {
    const s = { createdAt: new Date(t0), lastSeenAt: new Date(t0), expiresAt: new Date(t0 + STAFF_SESSION_MS) };
    expect(nextSessionExpiry(s, t0 + 3 * H)).toBeNull();
  });
  it("renews by exactly the idle lifetime (8 h), and repeated renewals don't grow it", () => {
    let s = { createdAt: new Date(t0), lastSeenAt: new Date(t0), expiresAt: new Date(t0 + STAFF_SESSION_MS) };
    for (let i = 1; i <= 10; i++) {
      const now = s.expiresAt.getTime() - 3 * H; // active, 3 h before expiry each time
      const exp = nextSessionExpiry(s, now)!;
      expect(exp.getTime() - now).toBe(STAFF_SESSION_MS); // constant: no growth (the old bug grew it each time)
      const idle = s.expiresAt.getTime() - s.lastSeenAt.getTime();
      s = { createdAt: s.createdAt, lastSeenAt: new Date(exp.getTime() - idle), expiresAt: exp };
    }
  });
  it("never exceeds createdAt + 30 days, however active", () => {
    const created = t0;
    const s = { createdAt: new Date(created), lastSeenAt: new Date(created + ABSOLUTE_SESSION_MS - 6 * H), expiresAt: new Date(created + ABSOLUTE_SESSION_MS - 6 * H + STAFF_SESSION_MS) };
    const now = s.expiresAt.getTime() - 3 * H;
    const exp = nextSessionExpiry(s, now);
    expect(exp === null || exp.getTime() <= created + ABSOLUTE_SESSION_MS).toBe(true);
  });
  it("long (parent/student) sessions can't be extended past the absolute cap either", () => {
    const s = { createdAt: new Date(t0), lastSeenAt: new Date(t0), expiresAt: new Date(t0 + LONG_SESSION_MS) };
    const now = t0 + 20 * 24 * H;
    expect(nextSessionExpiry(s, now)).toBeNull(); // cap == current expiry → nothing to extend
  });
  it("uses the __Host- cookie prefix over HTTPS only", () => {
    expect(sessionCookieName("https://school.example.test")).toBe("__Host-sid");
    expect(sessionCookieName("http://localhost:3000")).toBe("sid");
  });
});

describe("I — Content-Security-Policy", () => {
  it("production policy: nonce + strict-dynamic, no unsafe-inline/eval for scripts, no framing", () => {
    const csp = buildCsp({ nonce: "abc123", dev: false, https: true });
    const script = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toMatch(/unsafe-inline|unsafe-eval/);
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "upgrade-insecure-requests"]) {
      expect(csp).toContain(d);
    }
  });
  it("development adds only what React Refresh needs", () => {
    const csp = buildCsp({ nonce: "n", dev: true, https: false });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
  it("nonces are unique and 128-bit", () => {
    const set = new Set(Array.from({ length: 100 }, createNonce));
    expect(set.size).toBe(100);
    expect(Buffer.from([...set][0], "base64")).toHaveLength(16);
  });
});

describe("F/G — no PII or secrets in rate-limit keys or audit entries", () => {
  it("bucket keys never contain the raw username/email", () => {
    const key = bucketKey(RULES.passwordReset, "id:principal@school.example.test", 1700000000);
    expect(key).not.toContain("principal");
    expect(key).not.toContain("@");
    expect(bucketKey(RULES.passwordReset, "id:principal@school.example.test", 1700000000)).toBe(key); // deterministic
  });
  it("audit redaction covers tokens and one-time passwords", () => {
    expect(redact({ token: "t", temporaryPassword: "p", newPassword: "n", secret: "s", ok: 1 })).toEqual({
      token: "[REDACTED]", temporaryPassword: "[REDACTED]", newPassword: "[REDACTED]", secret: "[REDACTED]", ok: 1,
    });
  });
});

describe("J — public school name is cached (crawlers mustn't keep Neon awake)", () => {
  beforeEach(() => {
    vi.resetModules();
    findUnique.mockReset();
  });
  it("hits the DB at most once per 5 minutes and degrades gracefully", async () => {
    const { getSchoolName, invalidateSchoolNameCache } = await import("@/modules/settings/settings.public");
    invalidateSchoolNameCache();
    findUnique.mockResolvedValue({ name: "Demo Public School" });
    const t = 1_000_000;
    expect(await getSchoolName(t)).toBe("Demo Public School");
    expect(await getSchoolName(t + 60_000)).toBe("Demo Public School");
    expect(await getSchoolName(t + 4 * 60_000)).toBe("Demo Public School");
    expect(findUnique).toHaveBeenCalledTimes(1);
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await getSchoolName(t + 6 * 60_000)).toBe("Demo Public School"); // last good value survives an outage
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(await getSchoolName(t + 6 * 60_000 + 10_000)).toBe("Demo Public School"); // failure cached 30 s
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
