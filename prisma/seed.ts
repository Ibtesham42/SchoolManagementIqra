/**
 * Idempotent, transactional, target-guarded seed (ADR-032): permissions, roles, default grants, a
 * placeholder SchoolSetting and (optionally) the first Super Admin.
 *
 *   npm run db:seed        ← the only supported way (not `prisma db seed`, which pre-loads env vars)
 *
 * Safety (all fail closed, nothing written on any refusal):
 * - refuses if the shell pre-sets DOTENV_PATH / DOTENV_CONFIG_PATH or any database URL;
 * - loads exactly <project>/.env (never DOTENV_PATH);
 * - DATABASE_URL must be the endpoint in SEED_TARGET_ENDPOINT_ID, not forbidden, not the test
 *   endpoint; the server's own branch/endpoint must equal SEED_TARGET_BRANCH_ID/ENDPOINT_ID —
 *   checked in a read-only session first and again inside the write transaction;
 * - everything is written in ONE transaction that starts with lockSuperAdminGuard and ends with a
 *   full catalog verification; audit entries are written in the same transaction;
 * - a Super Admin is created only if no active Super Admin exists (never a second one), with
 *   mustChangePassword = true. Existing users and passwords are never changed.
 * - Never overwrites grants that Super Admin edited (only roles created by this run, plus the
 *   system SUPER_ADMIN role, receive grants).
 */
import { resolve } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { prisma } from "../src/lib/db";
import { IDENTITY_SQL, type DbIdentity } from "../src/lib/db-target-guard";
import { hashPassword, passwordProblem } from "../src/lib/auth/password";
import { runGuardedSeed, seedInTransaction } from "./seed-core";

// Captured before anything loads a .env file — a shell value would silently override the file.
const shellEnv = { ...process.env };

async function preCheckIdentity(databaseUrl: string): Promise<DbIdentity> {
  const c = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 20_000 });
  await c.connect();
  try {
    await c.query("SET default_transaction_read_only = on");
    const { rows } = await c.query<DbIdentity>(IDENTITY_SQL);
    return rows[0];
  } finally {
    await c.end();
  }
}

const sanitize = (m: string) => m.replace(/postgres(ql)?:\/\/[^\s]+/g, "<url>").replace(/npg_[A-Za-z0-9]+/g, "***");

runGuardedSeed({
  shellEnv,
  loadEnvFile: () => {
    config({ path: resolve(process.cwd(), ".env"), quiet: true });
    return process.env;
  },
  preCheckIdentity,
  hashPassword,
  passwordProblem,
  // Prisma's default interactive-transaction limits (5 s / 2 s) are too short over a network.
  runTransaction: (opts) => prisma.$transaction((tx) => seedInTransaction(tx, opts), { timeout: 60_000, maxWait: 15_000 }),
  log: (l) => console.log(l),
})
  .then(async (r) => {
    const s = r.stats;
    console.log(
      `✓ committed: permissions +${s.permissionsCreated} (${s.permissionsUpdated} updated), roles +${s.rolesCreated.length}, grants +${s.grantsCreated} (+${s.newPermissionGrantsCreated} for new permissions on existing roles, ${s.grantScopesSynced} scopes synced), settings ${s.settingsCreated ? "created" : "kept"}`,
    );
    if (r.superAdmin.action === "create") console.log("✓ Super Admin created (password change required on first sign-in)");
    else if (r.superAdmin.action === "skip") console.log(`• Super Admin: ${r.superAdmin.reason}`);
    const [p, ro, rp] = await Promise.all([prisma.permission.count(), prisma.role.count(), prisma.rolePermission.count()]);
    console.log(`Seed complete: ${p} permissions, ${ro} roles, ${rp} role grants.`);
  })
  .catch((e: unknown) => {
    console.error(`✗ ${sanitize(e instanceof Error ? e.message : String(e))}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
