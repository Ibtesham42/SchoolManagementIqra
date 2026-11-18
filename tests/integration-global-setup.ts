import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import pg from "pg";
import { assertRunIdentity, IDENTITY_SQL, INTEGRATION_TARGET, resolveRunTarget, SHELL_OVERRIDE_VARS, TargetGuardError } from "../src/lib/db-target-guard";

/**
 * S-05: Vitest globalSetup for `npm run test:integration` ONLY (vitest.config.ts). Runs once, before any
 * integration test file, and aborts the whole run unless the database the suites will WRITE to is provably
 * the Neon Test branch:
 *   1. no database URL / dotenv path may come from the shell (a stale shell value would win over .env);
 *   2. `.env` must name the target: TEST_TARGET_BRANCH_ID + TEST_TARGET_ENDPOINT_ID (allow-list), with
 *      FORBIDDEN_* (production) and SEED_TARGET_* (development) set so both can be refused; the
 *      TEST_DATABASE_URL host must be the allow-listed endpoint (decided before connecting);
 *   3. live, read-only: the server's own neon.branch_id / neon.endpoint_id must equal the allow-list.
 * Without TEST_DATABASE_URL the suites skip themselves and nothing is checked or connected.
 */
export default async function setup(): Promise<void> {
  const fromShell = SHELL_OVERRIDE_VARS.filter((k) => (process.env[k] ?? "") !== "");
  if (fromShell.length) {
    throw new TargetGuardError(`Refusing to run integration tests — ${fromShell.join(", ")} set in the shell. Integration tests read only the project's .env; open a new terminal. Nothing was written.`);
  }
  const env = existsSync(".env") ? parse(readFileSync(".env")) : {};
  if (!env.TEST_DATABASE_URL) {
    console.log("[integration] TEST_DATABASE_URL not set — the integration suites skip themselves.");
    return;
  }
  const target = resolveRunTarget(env, INTEGRATION_TARGET);
  const client = new pg.Client({ connectionString: env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query<{ branch: string | null; endpoint: string | null }>(IDENTITY_SQL);
    assertRunIdentity(rows[0], target, INTEGRATION_TARGET);
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
  console.log("[integration] target verified: the Test branch allow-listed in TEST_TARGET_* (read-only identity check).");
}
