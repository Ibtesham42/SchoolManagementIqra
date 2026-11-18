import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { bigintSafe } from "../bigint-json";

/**
 * PENDING until TEST_DATABASE_URL (Neon "test" branch, migrated) is configured — skipped otherwise.
 * ADR-032 seed core against a real database: one transaction, lock first, identity re-check before
 * writes, verification before commit, audit rows, no second Super Admin.
 *
 * Isolation: other suites create Super Admins on the shared test branch, so every test here runs
 * inside its own transaction (deactivating existing Super Admins there) and ends with a deliberate
 * rollback — nothing a test does is committed.
 */
// KI-043: runs only via `npm run test:integration` (explicit opt-in) AND with TEST_DATABASE_URL.
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/db-target-guard")),
  ...(await import("@/modules/identity/super-admin-guard")),
  ...(await import("../../prisma/seed-core")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

class Rollback extends Error {}

describe.skipIf(!enabled)("transactional seed (integration)", () => {
  const run = `sd${Date.now().toString(36)}`;
  const HASH = "$argon2id$v=19$m=19456,t=2,p=1$synthetic$synthetic"; // stand-in hash, never a password
  const noIdentityCheck = async () => undefined; // the test branch is not the seed's allow-listed target

  /** Runs `fn` inside a transaction that is always rolled back; returns fn's result. */
  async function inRolledBackTx<T>(fn: (tx: Parameters<Parameters<typeof m.prisma.$transaction>[0]>[0]) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await m.prisma
      .$transaction(
        async (tx) => {
          out = await fn(tx);
          throw new Rollback();
        },
        { timeout: 60_000, maxWait: 15_000 },
      )
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    return out as T;
  }

  async function withoutActiveSuperAdmins(tx: Parameters<Parameters<typeof m.prisma.$transaction>[0]>[0]) {
    // Rule 17: changing Super Admin activation takes the Super Admin lock FIRST — same lock order as
    // users.service, so this test can't deadlock with the identity-admin suite.
    await m.lockSuperAdminGuard(tx);
    await tx.$executeRaw`UPDATE "user" SET is_active = false WHERE id IN (SELECT ur.user_id FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE r.key = 'SUPER_ADMIN')`;
  }

  const seedAudits = () => m.prisma.auditLog.count({ where: { action: "seed.apply", entityId: "rbac-catalog" } });

  beforeAll(async () => {
    // Make sure the catalog exists once (committed) so the rollback tests start from a seeded state.
    await m.prisma.$transaction((tx) => m.seedInTransaction(tx, { plan: m.planSeed(), superAdmin: null, verifyIdentity: noIdentityCheck }), { timeout: 60_000, maxWait: 15_000 });
  });

  afterAll(async () => {
    await m.prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await m.prisma.$disconnect();
  });

  it("applies the whole catalog and creates the Super Admin with a forced password change, audited", async () => {
    const r = await inRolledBackTx(async (tx) => {
      await withoutActiveSuperAdmins(tx);
      const result = await m.seedInTransaction(tx, { plan: m.planSeed(), superAdmin: { username: `${run}-sa`, passwordHash: HASH }, verifyIdentity: noIdentityCheck });
      const user = await tx.user.findUniqueOrThrow({ where: { username: `${run}-sa` }, select: { id: true, mustChangePassword: true, passwordHash: true, roles: { select: { role: { select: { key: true } } } } } });
      const audits = await tx.auditLog.findMany({ where: { OR: [{ entityId: user.id }, { action: "seed.apply" }] }, orderBy: { id: "desc" }, take: 5 });
      return {
        result,
        user,
        counts: [await tx.permission.count(), await tx.role.count({ where: { key: { in: m.planSeed().roles.map((x) => x.key) } } })],
        audits,
      };
    });
    expect(r.result.superAdmin.action).toBe("create");
    expect(r.user.mustChangePassword).toBe(true);
    expect(r.user.passwordHash).toBe(HASH);
    expect(r.user.roles.map((x) => x.role.key)).toEqual(["SUPER_ADMIN"]);
    expect(r.counts[0]).toBeGreaterThanOrEqual(82);
    expect(r.counts[1]).toBe(13);
    const create = r.audits.find((a) => a.action === "user.create");
    expect(create?.actorId).toBeNull();
    expect(create?.actorLabel).toBe("system:seed");
    // Audit ids are BigInt — serialize them as strings (JSON.stringify can't encode BigInt).
    expect(JSON.stringify(r.audits, bigintSafe)).not.toMatch(/argon2|passwordHash":"\$|synthetic\$/);
    // rolled back: nothing persisted
    expect(await m.prisma.user.count({ where: { username: `${run}-sa` } })).toBe(0);
  });

  it("re-running is idempotent and never creates a second Super Admin, even with a new username", async () => {
    const r = await inRolledBackTx(async (tx) => {
      await withoutActiveSuperAdmins(tx);
      const first = await m.seedInTransaction(tx, { plan: m.planSeed(), superAdmin: { username: `${run}-one`, passwordHash: HASH }, verifyIdentity: noIdentityCheck });
      const second = await m.seedInTransaction(tx, { plan: m.planSeed(), superAdmin: { username: `${run}-two`, passwordHash: HASH }, verifyIdentity: noIdentityCheck });
      return { first, second, two: await tx.user.count({ where: { username: `${run}-two` } }) };
    });
    expect(r.first.superAdmin.action).toBe("create");
    expect(r.second.superAdmin.action).toBe("skip");
    expect(r.two).toBe(0);
    expect(r.second.stats).toMatchObject({ permissionsCreated: 0, rolesCreated: [], grantsCreated: 0, settingsCreated: false });
  });

  it("a failure after writes rolls everything back (no audit row, no user)", async () => {
    const plain = await m.prisma.user.create({ data: { username: `${run}-plain`, displayName: "Plain", passwordHash: "x" } });
    const before = await seedAudits();
    await expect(
      m.prisma.$transaction(
        async (tx) => {
          await withoutActiveSuperAdmins(tx);
          // username of an existing non–Super Admin → refused AFTER the catalog writes
          return m.seedInTransaction(tx, { plan: m.planSeed(), superAdmin: { username: plain.username, passwordHash: HASH }, verifyIdentity: noIdentityCheck });
        },
        { timeout: 60_000, maxWait: 15_000 },
      ),
    ).rejects.toBeInstanceOf(m.SeedError);
    expect(await seedAudits()).toBe(before);
    const after = await m.prisma.user.findUniqueOrThrow({ where: { id: plain.id }, select: { roles: true, isActive: true } });
    expect(after.roles).toEqual([]); // not elevated
    expect(await m.prisma.user.count({ where: { isActive: false, roles: { some: { role: { key: "SUPER_ADMIN" } } }, username: { startsWith: run } } })).toBe(0);
  });

  it("the in-transaction identity re-check refuses before any write", async () => {
    const before = await seedAudits();
    const target = m.resolveSeedTarget({
      DATABASE_URL: "postgresql://u:p@ep-dev-bbbb2222-pooler.region.invalid/neondb",
      SEED_TARGET_BRANCH_ID: "br-dev-bbbb2222",
      SEED_TARGET_ENDPOINT_ID: "ep-dev-bbbb2222",
      FORBIDDEN_BRANCH_IDS: "br-prod-aaaa1111",
      FORBIDDEN_ENDPOINT_IDS: "ep-prodn-aaaa1111",
    });
    await expect(
      m.prisma.$transaction((tx) => m.seedInTransaction(tx, { plan: m.planSeed(), superAdmin: null, verifyIdentity: async (t) => m.assertLiveIdentity(await m.queryIdentity(t), target) }), { timeout: 60_000, maxWait: 15_000 }),
    ).rejects.toBeInstanceOf(m.TargetGuardError); // the test branch is not the allow-listed target
    expect(await seedAudits()).toBe(before);
  });

  it("verifySeed rejects an incomplete catalog (so the transaction would roll back)", async () => {
    const message = await inRolledBackTx(async (tx) => {
      const sa = await tx.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" }, select: { id: true } });
      await tx.rolePermission.deleteMany({ where: { roleId: sa.id, permission: { key: "audit.read" } } });
      return m.verifySeed(tx, m.planSeed(), ["SUPER_ADMIN"]).then(() => "passed", (e: Error) => e.message);
    });
    expect(message).toMatch(/SUPER_ADMIN does not hold the whole catalog/);
  });
});
