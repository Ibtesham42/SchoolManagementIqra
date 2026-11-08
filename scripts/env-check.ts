/**
 * Environment + Neon branch identity check: `npm run env:check`
 * Prints NO secret values — only pass/fail per check, masked hosts and opaque branch fingerprints.
 * Exits non-zero if anything is uncertain, so migrations/seed are never run against the wrong branch.
 *
 * Optional: FORBIDDEN_BRANCH_IDS=br-a,br-b  (branches that must never be targeted, e.g. production)
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import pg from "pg";

let failed = false;
const ok = (msg: string) => console.log(`✓ ${msg}`);
const bad = (msg: string) => {
  failed = true;
  console.log(`✗ ${msg}`);
};
const fp = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8); // opaque fingerprint

function parse(name: string) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    bad(`${name}: not a valid URL`);
    return null;
  }
}

async function identity(name: string, url: URL) {
  const c = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 20_000 });
  await c.connect();
  try {
    await c.query("SET default_transaction_read_only = on");
    const { rows } = await c.query<{ branch: string | null; endpoint: string | null; version: string }>(
      `SELECT current_setting('neon.branch_id', true) AS branch,
              current_setting('neon.endpoint_id', true) AS endpoint,
              current_setting('server_version') AS version`,
    );
    return rows[0];
  } finally {
    await c.end();
  }
}

async function main() {
  // 1. Required variables present (names only)
  const required = ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", "APP_URL", "SESSION_SECRET", "DATA_ENCRYPTION_KEY", "DATA_HMAC_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) bad(`missing variables: ${missing.join(", ")}`);
  else ok(`all ${required.length} required variables present`);

  for (const k of ["DATA_ENCRYPTION_KEY", "DATA_HMAC_KEY"]) {
    const v = process.env[k];
    if (v && Buffer.from(v, "base64").length !== 32) bad(`${k}: must decode to 32 bytes`);
  }
  if ((process.env.SESSION_SECRET ?? "").length < 32) bad("SESSION_SECRET: shorter than 32 characters");
  if (process.env.DATA_ENCRYPTION_KEY && process.env.DATA_ENCRYPTION_KEY === process.env.DATA_HMAC_KEY) {
    bad("DATA_ENCRYPTION_KEY and DATA_HMAC_KEY must differ");
  }
  const seedUser = process.env.SEED_SUPERADMIN_USERNAME;
  const seedPass = process.env.SEED_SUPERADMIN_PASSWORD;
  if (!seedUser || !seedPass) bad("SEED_SUPERADMIN_USERNAME/PASSWORD not set");
  else if (seedPass.length < 10) bad("SEED_SUPERADMIN_PASSWORD shorter than 10 characters");

  // 2. URL shape
  const dev = parse("DATABASE_URL");
  const direct = parse("DIRECT_URL");
  const test = parse("TEST_DATABASE_URL");
  if (!dev || !direct || !test) return finish();

  const pooled = (u: URL) => u.hostname.includes("-pooler");
  pooled(dev) ? ok("DATABASE_URL uses the pooled endpoint") : bad("DATABASE_URL should be the POOLED string (host contains -pooler)");
  !pooled(direct) ? ok("DIRECT_URL uses the direct endpoint") : bad("DIRECT_URL must be the DIRECT string (no -pooler)");
  for (const [n, u] of [["DATABASE_URL", dev], ["DIRECT_URL", direct], ["TEST_DATABASE_URL", test]] as const) {
    const mode = u.searchParams.get("sslmode");
    if (!mode || mode === "disable" || mode === "allow") bad(`${n}: sslmode must be require/verify-full`);
    if (/prod/i.test(u.toString())) bad(`${n}: contains "prod" — refusing`);
  }
  if (dev.toString() === test.toString()) bad("TEST_DATABASE_URL is identical to DATABASE_URL");

  // 3. Branch identity (read-only sessions)
  const [a, b, t] = await Promise.all([identity("DATABASE_URL", dev), identity("DIRECT_URL", direct), identity("TEST_DATABASE_URL", test)]);
  if (!a.branch || !b.branch || !t.branch) bad("could not read neon.branch_id — cannot confirm branch identity");
  else {
    console.log(`  development branch fingerprint ${fp(a.branch)} (pooled) / ${fp(b.branch)} (direct); test ${fp(t.branch)}; PostgreSQL ${a.version}`);
    a.branch === b.branch ? ok("DATABASE_URL and DIRECT_URL are the same branch") : bad("DATABASE_URL and DIRECT_URL point to DIFFERENT branches");
    t.branch !== a.branch ? ok("test branch is different from development") : bad("TEST_DATABASE_URL is the SAME branch as development");
    const forbidden = (process.env.FORBIDDEN_BRANCH_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const [label, id] of [["development", a.branch], ["test", t.branch]] as const) {
      if (forbidden.includes(id)) bad(`${label} branch is in FORBIDDEN_BRANCH_IDS (e.g. production) — refusing`);
    }
    if (forbidden.length) ok(`neither branch is one of the ${forbidden.length} forbidden branch id(s)`);
  }
  finish();
}

function finish() {
  console.log(failed ? "ENV CHECK FAILED — do not migrate or seed" : "ENV CHECK PASSED");
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.log(`✗ ${(e as Error).message.replace(/postgres(ql)?:\/\/[^\s]+/g, "<url>").replace(/npg_[A-Za-z0-9]+/g, "***")}`);
  console.log("ENV CHECK FAILED — do not migrate or seed");
  process.exitCode = 1;
});
