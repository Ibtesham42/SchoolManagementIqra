/**
 * Shared integration-test precondition (KI-044): the full RBAC catalog — 84 permissions, 13 roles,
 * 300 grants — via the transactional seed core, catalog only (no Super Admin, no user).
 *
 * Replaces the per-suite row-by-row upsert loops (~350 sequential round trips, which exceeded hook
 * timeouts against remote Neon). One batched transaction instead, and a stronger guarantee: after
 * the seed core's own checks, EVERY catalog role must match its catalog grants exactly — if the
 * test database has drifted, setup fails loudly instead of silently continuing.
 *
 * Not a *.test.ts file, so it is never collected on its own. Imported lazily by the integration
 * suites, which run only via `npm run test:integration` against the verified test branch (KI-043).
 * The seed CLI's target guard (ADR-032) is for `npm run db:seed`; here the target is the test
 * branch, already gated by the integration opt-in and the pre-run identity check (G5).
 */
export const CATALOG_COUNTS = { permissions: 84, roles: 13, grants: 300 } as const;

export async function ensureCatalog(): Promise<void> {
  const { prisma } = await import("@/lib/db");
  const core = await import("../../prisma/seed-core");
  const plan = core.planSeed();
  if (plan.permissions.length !== CATALOG_COUNTS.permissions || plan.roles.length !== CATALOG_COUNTS.roles || plan.totalGrants !== CATALOG_COUNTS.grants) {
    throw new Error("Catalog plan does not match the expected 84 / 13 / 300");
  }
  await prisma.$transaction(
    async (tx) => {
      await core.seedInTransaction(tx, { plan, superAdmin: null, verifyIdentity: async () => undefined });
      await core.verifySeed(tx, plan, plan.roles.map((r) => r.key)); // every catalog role, exactly
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}
