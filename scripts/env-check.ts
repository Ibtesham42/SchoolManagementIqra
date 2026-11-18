/**
 * Environment + Neon branch identity check: `npm run env:check`
 * Prints NO secret values — only pass/fail per check, counts and opaque 8-character fingerprints.
 * Exits non-zero if anything is uncertain, so migrations/seed are never run against the wrong branch.
 *
 * Connected mode requires both protections (ids are not secrets):
 *   FORBIDDEN_BRANCH_IDS=br-…     (e.g. the production branch) — refused after reading the branch id
 *   FORBIDDEN_ENDPOINT_IDS=ep-…   (e.g. the production endpoint) — refused from the host name,
 *                                 BEFORE any connection is attempted
 * It connects only if every other check passed, and only to DATABASE_URL, DIRECT_URL and
 * TEST_DATABASE_URL, in read-only sessions.
 *
 * `npm run env:check -- --offline` (`npm run env:check:offline`) — files and formats only, never
 * opens a connection.
 *
 * All logic lives in scripts/env-check-lib.ts (unit-tested); this file only loads .env and supplies
 * the real side effects.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { runEnvCheck, sanitizeError, type BranchIdentity } from "./env-check-lib";

async function identity(_name: string, url: URL): Promise<BranchIdentity> {
  const c = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 20_000 });
  await c.connect();
  try {
    await c.query("SET default_transaction_read_only = on");
    const { rows } = await c.query<BranchIdentity>(
      `SELECT current_setting('neon.branch_id', true) AS branch,
              current_setting('neon.endpoint_id', true) AS endpoint,
              current_setting('server_version') AS version`,
    );
    return rows[0];
  } finally {
    await c.end();
  }
}

runEnvCheck(
  process.env,
  { identity, exists: existsSync, readFile: (p) => readFileSync(p, "utf8"), log: (l) => console.log(l), cwd: process.cwd() },
  process.argv.includes("--offline"),
)
  .then((passed) => {
    if (!passed) process.exitCode = 1;
  })
  .catch((e: unknown) => {
    console.log(`✗ ${sanitizeError(e instanceof Error ? e.message : String(e))}`);
    console.log("ENV CHECK FAILED — do not migrate or seed");
    process.exitCode = 1;
  });
