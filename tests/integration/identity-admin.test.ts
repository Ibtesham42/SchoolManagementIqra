import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * PENDING until TEST_DATABASE_URL (Neon "test" branch, migrated) is configured — skipped otherwise.
 * Exercises user/role administration and password reset through real transactions.
 */
const enabled = !!process.env.TEST_DATABASE_URL;

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/rbac/catalog")),
  ...(await import("@/lib/rbac/authorize")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/modules/identity/users.service")),
  ...(await import("@/modules/identity/roles.service")),
  ...(await import("@/modules/identity/password-reset.service")),
  ...(await import("@/modules/identity/auth.service")),
  ...(await import("@/lib/maintenance")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("identity administration (integration)", () => {
  const run = `ia${Date.now().toString(36)}`;
  const ip = { ipHash: `ip-${run}` };
  let superCtx: Awaited<ReturnType<typeof m.validateSessionToken>>;

  async function ctxFor(userId: string) {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }

  beforeAll(async () => {
    const { prisma, ROLES, ALL_PERMISSION_KEYS, normalizeGrant } = m;
    for (const key of ALL_PERMISSION_KEYS) {
      await prisma.permission.upsert({ where: { key }, create: { key, module: key.split(".")[0], description: key }, update: {} });
    }
    const permIds = new Map((await prisma.permission.findMany()).map((p) => [p.key, p.id]));
    for (const def of ROLES) {
      const role = await prisma.role.upsert({ where: { key: def.key }, create: { key: def.key, name: def.name, isSystem: !!def.isSystem }, update: {} });
      for (const g of def.grants) {
        const { key, scope } = normalizeGrant(g);
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId: permIds.get(key)! } },
          create: { roleId: role.id, permissionId: permIds.get(key)!, scope },
          update: {},
        });
      }
    }
    const sa = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    const u = await prisma.user.create({
      data: { username: `${run}-root`, displayName: "Root", passwordHash: "x", roles: { create: { roleId: sa.id } } },
    });
    superCtx = await ctxFor(u.id);
  });

  afterAll(async () => {
    await m.prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await m.prisma.role.deleteMany({ where: { key: { startsWith: "IT_" } } });
    await m.prisma.$disconnect();
  });

  it("creates a user with a one-time temporary password that forces a change", async () => {
    const { user, temporaryPassword } = await m.createUser(superCtx!, {
      username: `${run}-t1`, displayName: "Teacher One", email: `${run}-t1@example.test`, roleKeys: ["TEACHER"],
    });
    const login = await m.login({ username: user.username, password: temporaryPassword, remember: false }, ip);
    expect(login.mustChangePassword).toBe(true);
    const row = await m.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).not.toContain(temporaryPassword);
    expect(await m.prisma.auditLog.count({ where: { action: "user.create", entityId: user.id } })).toBe(1);
  });

  it("rejects duplicate usernames and emails with friendly conflicts", async () => {
    await expect(m.createUser(superCtx!, { username: `${run}-t1`, displayName: "Dup", email: null, roleKeys: [] })).rejects.toThrow(/username is already taken/);
    await expect(
      m.createUser(superCtx!, { username: `${run}-t2`, displayName: "Dup", email: `${run}-t1@example.test`, roleKeys: [] }),
    ).rejects.toThrow(/email address is already used/);
  });

  it("role changes take effect on the next request; deactivation ends sessions", async () => {
    const t = await m.prisma.user.findUniqueOrThrow({ where: { username: `${run}-t1` } });
    const session = await m.createSession(t.id, { long: false });
    await m.updateUser(superCtx!, { id: t.id, displayName: "Teacher One", email: t.email, roleKeys: ["TEACHER", "LIBRARIAN"] });
    const ctx = await m.validateSessionToken(session.token);
    expect(ctx!.permissions.has("library.manage")).toBe(true);
    await m.setUserActive(superCtx!, t.id, false);
    expect(await m.validateSessionToken(session.token)).toBeNull();
    await m.setUserActive(superCtx!, t.id, true);
  });

  it("delegated admins cannot touch Super Admins or escalate", async () => {
    const custom = await m.prisma.role.create({ data: { key: `IT_DELEGATE_${run.toUpperCase()}`, name: "Delegate" } });
    const ids = new Map((await m.prisma.permission.findMany()).map((p) => [p.key, p.id]));
    await m.prisma.rolePermission.createMany({
      data: ["user.read", "user.manage", "role.manage", "student.read"].map((k) => ({ roleId: custom.id, permissionId: ids.get(k)!, scope: "ALL" as const })),
    });
    const d = await m.prisma.user.create({ data: { username: `${run}-delegate`, displayName: "Delegate", passwordHash: "x", roles: { create: { roleId: custom.id } } } });
    const dctx = await ctxFor(d.id);
    const root = await m.prisma.user.findUniqueOrThrow({ where: { username: `${run}-root` } });
    await expect(m.setUserActive(dctx, root.id, false)).rejects.toThrow(/Only a Super Admin/);
    await expect(m.createUser(dctx, { username: `${run}-x`, displayName: "X", email: null, roleKeys: ["SUPER_ADMIN"] })).rejects.toThrow(/Super Admin role/);
    await expect(m.createUser(dctx, { username: `${run}-y`, displayName: "Y", email: null, roleKeys: ["ACCOUNTANT"] })).rejects.toThrow(/do not hold/);
    const lib = await m.prisma.role.findUniqueOrThrow({ where: { key: "LIBRARIAN" } });
    await expect(m.setRolePermissions(dctx, { id: lib.id, grants: [{ key: "payroll.read", scope: "ALL" }] })).rejects.toThrow(/payroll.read/);
    await expect(m.setRolePermissions(dctx, { id: custom.id, grants: [] })).rejects.toThrow(/role you hold/);
  });

  it("keeps at least one active Super Admin, even under concurrent deactivation", async () => {
    const sa = await m.prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    // Isolate: this test needs to know every active Super Admin.
    const others = await m.prisma.user.findMany({ where: { isActive: true, roles: { some: { roleId: sa.id } }, username: { not: { startsWith: run } } } });
    if (others.length > 0) return; // shared test DB with real admins — covered by unit tests instead
    const a = await m.prisma.user.create({ data: { username: `${run}-sa-a`, displayName: "A", passwordHash: "x", roles: { create: { roleId: sa.id } } } });
    const actx = await ctxFor(a.id);
    const root = await m.prisma.user.findUniqueOrThrow({ where: { username: `${run}-root` } });
    // root and a deactivate each other at the same time: exactly one must succeed.
    const results = await Promise.allSettled([m.setUserActive(superCtx!, a.id, false), m.setUserActive(actx, root.id, false)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const remaining = await m.prisma.user.count({ where: { isActive: true, roles: { some: { roleId: sa.id } } } });
    expect(remaining).toBeGreaterThanOrEqual(1);
    await m.prisma.user.updateMany({ where: { username: { startsWith: run } }, data: { isActive: true } });
  });

  it("race: 'remove Super Admin role from A' vs 'deactivate B' never leaves zero Super Admins", async () => {
    const sa = await m.prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    const others = await m.prisma.user.findMany({ where: { isActive: true, roles: { some: { roleId: sa.id } }, username: { not: { startsWith: run } } } });
    if (others.length > 0) return; // shared DB with real admins — invariant covered by unit tests
    await m.prisma.user.updateMany({ where: { username: { startsWith: run } }, data: { isActive: true } });
    const a = await m.prisma.user.upsert({
      where: { username: `${run}-sa-a` },
      create: { username: `${run}-sa-a`, displayName: "A", passwordHash: "x", roles: { create: { roleId: sa.id } } },
      update: {},
    });
    const root = await m.prisma.user.findUniqueOrThrow({ where: { username: `${run}-root` } });
    // Make exactly two active Super Admins: root and a.
    const actx = await ctxFor(a.id);
    for (let i = 0; i < 5; i++) {
      const results = await Promise.allSettled([
        m.updateUser(superCtx!, { id: a.id, displayName: "A", email: null, roleKeys: [] }), // root removes A's SA role
        m.setUserActive(actx, root.id, false), // A deactivates root
      ]);
      const remaining = await m.prisma.user.count({ where: { isActive: true, roles: { some: { roleId: sa.id } } } });
      expect(remaining).toBeGreaterThanOrEqual(1);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(1);
      // reset for the next round
      await m.prisma.user.update({ where: { id: root.id }, data: { isActive: true } });
      await m.prisma.userRole.upsert({ where: { userId_roleId: { userId: a.id, roleId: sa.id } }, create: { userId: a.id, roleId: sa.id }, update: {} });
    }
  });

  it("a delegated admin cannot reset the password of a more-privileged user (account takeover)", async () => {
    const custom = await m.prisma.role.findFirstOrThrow({ where: { key: { startsWith: "IT_DELEGATE_" } } });
    const d = await m.prisma.user.findUniqueOrThrow({ where: { username: `${run}-delegate` } });
    const dctx = await ctxFor(d.id);
    const principal = await m.prisma.role.findUniqueOrThrow({ where: { key: "PRINCIPAL" } });
    const p = await m.prisma.user.create({
      data: { username: `${run}-principal`, displayName: "Principal", passwordHash: "x", roles: { create: { roleId: principal.id } } },
    });
    await expect(m.adminResetPassword(dctx, p.id)).rejects.toThrow(/permissions you also hold/);
    await expect(m.setUserActive(dctx, p.id, false)).rejects.toThrow(/permissions you also hold/);
    await expect(m.revokeUserSessions(dctx, p.id)).rejects.toThrow(/permissions you also hold/);
    expect(custom.key).toMatch(/^IT_DELEGATE_/);
  });

  it("system role is immutable; custom roles can be created, edited and deleted", async () => {
    const sa = await m.prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    await expect(m.setRolePermissions(superCtx!, { id: sa.id, grants: [] })).rejects.toThrow(/System roles/);
    const r = await m.createRole(superCtx!, { key: `IT_COORD_${run.toUpperCase()}`, name: "Coordinator", description: "" });
    await m.setRolePermissions(superCtx!, { id: r.id, grants: [{ key: "timetable.read", scope: "ALL" }, { key: "student.read", scope: "ASSIGNED" }] });
    expect((await m.getRole(superCtx!, r.id)).grants).toHaveLength(2);
    await m.deleteRole(superCtx!, r.id);
    await expect(m.getRole(superCtx!, r.id)).rejects.toThrow(/not found/i);
  });

  it("password reset: neutral for unknown users, single-use link, ends sessions", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "log");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(m.requestPasswordReset({ identifier: `${run}-nobody` }, ip)).resolves.toBeUndefined();

    const t = await m.prisma.user.findUniqueOrThrow({ where: { username: `${run}-t1` } });
    const s = await m.createSession(t.id, { long: false });
    await m.requestPasswordReset({ identifier: t.email! }, ip);
    const outbox = join(process.cwd(), "tmp", "outbox");
    const file = readdirSync(outbox).filter((f) => f.endsWith("-password_reset.json")).sort().at(-1)!;
    const token = /token=([^\s]+)/.exec(JSON.parse(readFileSync(join(outbox, file), "utf8")).text)![1];
    rmSync(join(outbox, file));

    expect(await m.checkResetToken(decodeURIComponent(token))).toBe(true);
    await m.completePasswordReset({ token: decodeURIComponent(token), newPassword: "a brand new passphrase", confirmPassword: "a brand new passphrase" }, ip);
    expect(await m.validateSessionToken(s.token)).toBeNull();
    await expect(
      m.completePasswordReset({ token: decodeURIComponent(token), newPassword: "another passphrase!", confirmPassword: "another passphrase!" }, ip),
    ).rejects.toThrow(/invalid or has expired/);
    const ok = await m.login({ username: t.username, password: "a brand new passphrase", remember: false }, ip);
    expect(ok.mustChangePassword).toBe(false);
    vi.unstubAllEnvs();
  });

  it("cleanup removes expired sessions and buckets only", async () => {
    const t = await m.prisma.user.findUniqueOrThrow({ where: { username: `${run}-t1` } });
    await m.prisma.session.create({ data: { userId: t.id, tokenHash: `expired-${run}`, expiresAt: new Date(Date.now() - 1000) } });
    const live = await m.createSession(t.id, { long: false });
    const r = await m.runCleanup();
    expect(r.sessions).toBeGreaterThanOrEqual(1);
    expect(await m.validateSessionToken(live.token)).not.toBeNull();
  });
});
