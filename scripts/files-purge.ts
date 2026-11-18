/**
 * S-15 purge job runner (owner decision 2026-11-18): `npm run files:purge` (dry run — reads only) or
 * `npm run files:purge -- --apply` (owner-approved runs only). Target-guarded like the seed (ADR-032):
 * shell must not pre-set database URLs / dotenv paths; loads exactly <project>/.env; DATABASE_URL must be the
 * allow-listed SEED_TARGET endpoint (not forbidden, not test), confirmed by the server's own identity in a
 * read-only session before anything runs. Requires migration 20261118000100 (purged_at).
 */
import { resolve } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { assertLiveIdentity, assertShellClean, IDENTITY_SQL, resolveSeedTarget, type DbIdentity } from "../src/lib/db-target-guard";

const shellEnv = { ...process.env };
const apply = process.argv.includes("--apply");

async function main() {
  assertShellClean(shellEnv);
  config({ path: resolve(process.cwd(), ".env"), quiet: true });
  const target = resolveSeedTarget(process.env);
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 20_000 });
  await c.connect();
  try {
    await c.query("SET default_transaction_read_only = on");
    assertLiveIdentity((await c.query<DbIdentity>(IDENTITY_SQL)).rows[0], target);
  } finally {
    await c.end();
  }
  console.log(`✓ target: the allow-listed branch (read-only identity check); mode = ${apply ? "APPLY" : "dry run (reads only)"}`);
  const { prisma } = await import("../src/lib/db");
  const { getStorageDriver } = await import("../src/lib/storage/driver");
  const { purgeRetiredFiles, PURGE_GRACE_DAYS } = await import("../src/modules/files/files-purge");
  try {
    const r = await purgeRetiredFiles({ db: prisma, driver: getStorageDriver(), actor: { userId: null, label: "system:files-purge" }, dryRun: !apply });
    console.log(`grace ${PURGE_GRACE_DAYS} days · eligible ${r.eligible} · purged ${r.purged} · invalid keys skipped ${r.invalidKey} · failed ${r.failed}${r.failed ? ` (${JSON.stringify(r.failures)})` : ""}`);
    if (r.failed) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`files:purge refused or failed: ${e instanceof Error ? e.name : "Error"}: ${(e instanceof Error ? e.message : String(e)).replace(/postgres\S+/g, "<url>")}`);
  process.exitCode = 1;
});
