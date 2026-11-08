import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 1 integration tests against a real Postgres (Neon "test" branch).
 * Requires TEST_DATABASE_URL with migrations applied: run
 *   DIRECT_URL=<test branch direct URL> npx prisma migrate deploy
 * Skipped (reported as skipped, not passed) when TEST_DATABASE_URL is absent.
 */
const enabled = !!process.env.TEST_DATABASE_URL;

// Modules that open a DB connection are only loaded when a test database is configured.
const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/sequence")),
  ...(await import("@/lib/usage")),
  ...(await import("@/lib/rate-limit")),
  ...(await import("@/lib/auth/password")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/modules/identity/auth.service")),
  ...(await import("@/lib/errors")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("Phase 1 — database integration", () => {
  const { prisma, nextSequence, consume, hit, hashPassword, validateSessionToken, revokeAllSessions, login } = m ?? {};
  const { MAX_FAILED_ATTEMPTS, QuotaExceededError } = m ?? {};

  const run = `t${Date.now().toString(36)}`;
  const ipHash = `ip-${run}`;

  beforeAll(async () => {
    const teacher = await prisma.role.upsert({
      where: { key: `TEST_ROLE_${run}` },
      create: { key: `TEST_ROLE_${run}`, name: "Test role" },
      update: {},
    });
    const perm = await prisma.permission.upsert({
      where: { key: "student.read" },
      create: { key: "student.read", module: "student", description: "View student records" },
      update: {},
    });
    await prisma.rolePermission.create({ data: { roleId: teacher.id, permissionId: perm.id, scope: "ASSIGNED" } });
    await prisma.user.create({
      data: {
        username: `user-${run}`,
        displayName: "Integration User",
        passwordHash: await hashPassword("correct horse battery"),
        roles: { create: { roleId: teacher.id } },
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: "user-t" } } });
    await prisma.role.deleteMany({ where: { key: { startsWith: "TEST_ROLE_" } } });
    await prisma.sequenceCounter.deleteMany({ where: { key: { startsWith: "test:" } } });
    await prisma.$disconnect();
  });

  it("50 concurrent sequence calls yield 50 unique consecutive numbers", async () => {
    const key = `test:${run}`;
    const values = await Promise.all(
      Array.from({ length: 50 }, () => prisma.$transaction((tx) => nextSequence(tx, key))),
    );
    expect(new Set(values).size).toBe(50);
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("a rolled-back transaction does not consume a sequence number", async () => {
    const key = `test:rb:${run}`;
    await prisma.$transaction((tx) => nextSequence(tx, key));
    await expect(
      prisma.$transaction(async (tx) => {
        await nextSequence(tx, key);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await prisma.$transaction((tx) => nextSequence(tx, key))).toBe(2);
  });

  it("login creates a session whose context carries scoped permissions; revocation ends it", async () => {
    const result = await login({ username: `user-${run}`, password: "correct horse battery", remember: false }, { ipHash });
    const ctx = await validateSessionToken(result.token);
    expect(ctx?.username).toBe(`user-${run}`);
    expect(ctx?.permissions.get("student.read")).toEqual(new Set(["ASSIGNED"]));
    await revokeAllSessions(ctx!.userId);
    expect(await validateSessionToken(result.token)).toBeNull();
  });

  it("locks the account after repeated failures with a generic error", async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await expect(login({ username: `user-${run}`, password: "wrong password!!", remember: false }, { ipHash })).rejects.toThrow(
        "Invalid username or password.",
      );
    }
    // Correct password is now rejected too, with the same message (no enumeration).
    await expect(
      login({ username: `user-${run}`, password: "correct horse battery", remember: false }, { ipHash }),
    ).rejects.toThrow("Invalid username or password.");
    const audit = await prisma.auditLog.findFirst({ where: { action: "auth.locked" }, orderBy: { at: "desc" } });
    expect(audit).not.toBeNull();
  });

  it("all 13 roles: permissions loaded from the DB through a real session match the catalog exactly", async () => {
    const { ROLES, ALL_PERMISSION_KEYS, normalizeGrant } = await import("@/lib/rbac/catalog");
    const { createSession } = await import("@/lib/auth/session");
    for (const key of ALL_PERMISSION_KEYS) {
      await prisma.permission.upsert({ where: { key }, create: { key, module: key.split(".")[0], description: key }, update: {} });
    }
    const permIds = new Map((await prisma.permission.findMany()).map((p) => [p.key, p.id]));
    for (const def of ROLES) {
      const roleKey = `${def.key}_${run}`;
      const role = await prisma.role.create({ data: { key: roleKey, name: def.name, isSystem: false } });
      await prisma.rolePermission.createMany({
        data: def.grants.map((g) => {
          const { key, scope } = normalizeGrant(g);
          return { roleId: role.id, permissionId: permIds.get(key)!, scope };
        }),
      });
      const user = await prisma.user.create({
        data: { username: `user-${run}-${def.key.toLowerCase()}`, displayName: def.name, passwordHash: "x", roles: { create: { roleId: role.id } } },
      });
      const { token } = await createSession(user.id, { long: false });
      const ctx = (await validateSessionToken(token))!;
      const expected = new Map(def.grants.map((g) => [normalizeGrant(g).key, normalizeGrant(g).scope]));
      expect(ctx.permissions.size).toBe(expected.size);
      for (const [perm, scope] of expected) expect([...ctx.permissions.get(perm)!]).toEqual([scope]);
      await prisma.role.update({ where: { id: role.id }, data: { key: `TEST_ROLE_${run}_${def.key}` } });
    }
  });

  it("deactivated users' sessions stop working immediately", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: `user-${run}` } });
    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: null, failedLoginCount: 0 } });
    const { createSession } = await import("@/lib/auth/session");
    const { token } = await createSession(user.id, { long: false });
    expect(await validateSessionToken(token)).not.toBeNull();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect(await validateSessionToken(token)).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });
  });

  it("audit entries roll back with their transaction (no orphan audit rows)", async () => {
    const { audit } = await import("@/lib/audit");
    const action = `test.rollback.${run}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await audit(tx, { userId: null }, { action, entityType: "Test" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await prisma.auditLog.count({ where: { action } })).toBe(0);
    await prisma.$transaction((tx) => audit(tx, { userId: null }, { action, entityType: "Test", after: { passwordHash: "secret" } }));
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action } });
    expect(row.after).toEqual({ passwordHash: "[REDACTED]" });
  });

  it("50 parallel sequence calls on independent connections (true concurrency) stay unique", async () => {
    const { default: pg } = await import("pg");
    const key = `test:raw:${run}`;
    const clients = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
        await c.connect();
        return c;
      }),
    );
    try {
      // Each client opens its own transaction; all 50 contend for the same counter row at once.
      const values = await Promise.all(
        clients.map(async (c) => {
          await c.query("BEGIN");
          const r = await c.query<{ value: number }>(
            `INSERT INTO sequence_counter (key, value, updated_at) VALUES ($1, 1, now())
             ON CONFLICT (key) DO UPDATE SET value = sequence_counter.value + 1, updated_at = now() RETURNING value`,
            [key],
          );
          await new Promise((res) => setTimeout(res, 5)); // hold the lock briefly to force contention
          await c.query("COMMIT");
          return r.rows[0].value;
        }),
      );
      expect(new Set(values).size).toBe(50);
      expect(Math.max(...values)).toBe(50);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it("rate limiter blocks after the limit within a window", async () => {
    const rule = { name: `test-rl-${run}`, limit: 3, windowSeconds: 60 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await hit(rule, "subject")).allowed);
    expect(results).toEqual([true, true, true, false]);
  });

  it("usage guard stops at the cap and never calls past it", async () => {
    process.env.USAGE_CAP_MEDIA_UPLOADS = "2";
    await prisma.usageCounter.deleteMany({ where: { metric: "media.uploads" } });
    await consume("media.uploads");
    const second = await consume("media.uploads");
    expect(second.level).toBe("exhausted");
    await expect(consume("media.uploads")).rejects.toBeInstanceOf(QuotaExceededError);
    const row = await prisma.usageCounter.findFirst({ where: { metric: "media.uploads" } });
    expect(row?.count).toBe(2);
    delete process.env.USAGE_CAP_MEDIA_UPLOADS;
  });
});
