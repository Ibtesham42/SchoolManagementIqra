/**
 * Logic of `npm run env:check` / `env:check:offline` (scripts/env-check.ts is the thin entry point).
 * Takes the environment and all side effects as parameters, never loads dotenv itself, and is
 * unit-tested in tests/unit/env-check.test.ts — in particular that a forbidden endpoint is refused
 * before any connection is attempted.
 *
 * Prints NO secret values: only ✓/✗ lines, counts and 8-character fingerprints.
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { BRANCH_ID, ENDPOINT_ID, endpointOfUrl, parseIdList } from "../src/lib/db-target-guard";
import { checkKeySeparation } from "../src/lib/env";

export { endpointOfUrl, parseIdList };

export interface BranchIdentity {
  branch: string | null;
  endpoint: string | null;
  version: string;
}

export interface EnvCheckDeps {
  /** Opens a read-only session and reports the Neon branch/endpoint — the ONLY network access. */
  identity(name: string, url: URL): Promise<BranchIdentity>;
  exists(path: string): boolean;
  readFile(path: string): string;
  log(line: string): void;
  cwd: string;
}

export const fingerprint = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

/**
 * Pure: which of the given URLs point at a forbidden endpoint (by the endpoint id in the host).
 * Needs no connection — this is what makes "refuse before connecting" possible.
 */
export function forbiddenEndpointHits(urls: [string, URL][], forbiddenEndpointIds: string[]): string[] {
  const forbidden = new Set(forbiddenEndpointIds);
  return urls.filter(([, u]) => forbidden.has(endpointOfUrl(u))).map(([name]) => name);
}

/** Returns true when every check passed. */
export async function runEnvCheck(env: Record<string, string | undefined>, deps: EnvCheckDeps, offline: boolean): Promise<boolean> {
  let failed = false;
  const ok = (msg: string) => deps.log(`✓ ${msg}`);
  const bad = (msg: string) => {
    failed = true;
    deps.log(`✗ ${msg}`);
  };
  const info = (msg: string) => deps.log(`  ${msg}`);
  const finish = () => {
    deps.log(failed ? "ENV CHECK FAILED — do not migrate or seed" : "ENV CHECK PASSED");
    return !failed;
  };
  const parse = (name: string, raw: string | undefined) => {
    if (!raw) return null;
    try {
      return new URL(raw);
    } catch {
      bad(`${name}: not a valid URL`);
      return null;
    }
  };

  deps.log(offline ? "Offline mode: no database connections will be opened." : "Connected mode: read-only sessions to development and test.");
  const envPath = resolve(deps.cwd, ".env");
  const envTestPath = resolve(deps.cwd, ".env.test");
  if (!deps.exists(envPath)) bad(".env not found in the project folder (NEON_SETUP_GUIDE Step 4)");

  // 1. Required variables (names only)
  const required = ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", "APP_URL", "SESSION_SECRET", "DATA_ENCRYPTION_KEY", "DATA_HMAC_KEY", "DOCUMENT_VERIFICATION_KEY"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) bad(`missing variables: ${missing.join(", ")}`);
  else ok(`all ${required.length} required variables present`);
  for (const k of ["DATA_ENCRYPTION_KEY", "DATA_HMAC_KEY", "DOCUMENT_VERIFICATION_KEY"]) {
    const v = env[k];
    if (v && Buffer.from(v, "base64").length !== 32) bad(`${k}: must decode to 32 bytes`);
  }
  if ((env.SESSION_SECRET ?? "").length < 32) bad("SESSION_SECRET: shorter than 32 characters");
  // Same rules as start-up validation — one implementation, so the two can't drift apart.
  const { DATA_ENCRYPTION_KEY, DATA_HMAC_KEY, DOCUMENT_VERIFICATION_KEY } = env;
  if (DATA_ENCRYPTION_KEY && DATA_HMAC_KEY && DOCUMENT_VERIFICATION_KEY) {
    const DOCUMENT_VERIFICATION_KEY_VERSION = Number(env.DOCUMENT_VERIFICATION_KEY_VERSION ?? 1);
    for (const p of checkKeySeparation({ DATA_ENCRYPTION_KEY, DATA_HMAC_KEY, DOCUMENT_VERIFICATION_KEY, DOCUMENT_VERIFICATION_KEY_VERSION }, env)) bad(p);
  }
  const version = Number(env.DOCUMENT_VERIFICATION_KEY_VERSION ?? 1);
  if (!Number.isInteger(version) || version < 1 || version > 32767) bad("DOCUMENT_VERIFICATION_KEY_VERSION: must be an integer from 1 to 32767");
  if (!env.SEED_SUPERADMIN_USERNAME || !env.SEED_SUPERADMIN_PASSWORD) bad("SEED_SUPERADMIN_USERNAME/PASSWORD not set");
  else if (env.SEED_SUPERADMIN_PASSWORD.length < 10) bad("SEED_SUPERADMIN_PASSWORD shorter than 10 characters");

  // 2. Production protection settings (ids only — not secrets)
  const forbiddenBranches = parseIdList(env.FORBIDDEN_BRANCH_IDS);
  const forbiddenEndpoints = parseIdList(env.FORBIDDEN_ENDPOINT_IDS);
  for (const id of forbiddenBranches) if (!BRANCH_ID.test(id)) bad(`FORBIDDEN_BRANCH_IDS: "${id.slice(0, 40)}" is not a Neon branch id (br-…)`);
  for (const id of forbiddenEndpoints) if (!ENDPOINT_ID.test(id)) bad(`FORBIDDEN_ENDPOINT_IDS: "${id.slice(0, 40)}" is not a Neon endpoint id (ep-…)`);

  // 3. URL shape
  const dev = parse("DATABASE_URL", env.DATABASE_URL);
  const direct = parse("DIRECT_URL", env.DIRECT_URL);
  const test = parse("TEST_DATABASE_URL", env.TEST_DATABASE_URL);
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
  const devEp = endpointOfUrl(dev);
  const directEp = endpointOfUrl(direct);
  const testEp = endpointOfUrl(test);
  info(`endpoint fingerprints: development ${fingerprint(devEp)} (pooled) / ${fingerprint(directEp)} (direct); test ${fingerprint(testEp)}`);
  devEp === directEp ? ok("DATABASE_URL and DIRECT_URL use the same endpoint") : bad("DATABASE_URL and DIRECT_URL are on DIFFERENT endpoints");
  testEp !== devEp ? ok("TEST_DATABASE_URL is a different endpoint from development") : bad("TEST_DATABASE_URL uses the DEVELOPMENT endpoint");
  checkPrivateStorageDir(env, deps.cwd, ok, bad);

  // 4. .env.test (offline file check; its URLs are also screened against forbidden endpoints)
  const testFileUrls = checkEnvTestFile(deps, envTestPath, devEp, testEp, ok, bad, info);

  // 5. Forbidden endpoints — decided from the host names alone, BEFORE any connection.
  const allUrls: [string, URL][] = [["DATABASE_URL", dev], ["DIRECT_URL", direct], ["TEST_DATABASE_URL", test], ...testFileUrls];
  const hits = forbiddenEndpointHits(allUrls, forbiddenEndpoints);
  for (const name of hits) bad(`${name} points to an endpoint in FORBIDDEN_ENDPOINT_IDS (e.g. production) — refusing to connect`);
  if (forbiddenEndpoints.length && !hits.length) ok(`no URL uses one of the ${forbiddenEndpoints.length} forbidden endpoint id(s)`);

  // 5b. Seed allow-list (used by `npm run db:seed`, ADR-032) — offline consistency.
  const seedBranch = (env.SEED_TARGET_BRANCH_ID ?? "").trim();
  const seedEndpoint = (env.SEED_TARGET_ENDPOINT_ID ?? "").trim();
  if (!seedBranch && !seedEndpoint) info("SEED_TARGET_BRANCH_ID / SEED_TARGET_ENDPOINT_ID not set (required by npm run db:seed)");
  else {
    if (!BRANCH_ID.test(seedBranch)) bad("SEED_TARGET_BRANCH_ID is missing or not a Neon branch id (br-…)");
    if (!ENDPOINT_ID.test(seedEndpoint)) bad("SEED_TARGET_ENDPOINT_ID is missing or not a Neon endpoint id (ep-…)");
    if (forbiddenBranches.includes(seedBranch) || forbiddenEndpoints.includes(seedEndpoint)) bad("SEED_TARGET_* is listed as FORBIDDEN — the seed would refuse");
    else if (seedEndpoint && seedEndpoint === testEp) bad("SEED_TARGET_ENDPOINT_ID is the TEST endpoint");
    else if (seedEndpoint && seedEndpoint !== devEp) bad("SEED_TARGET_ENDPOINT_ID does not match DATABASE_URL's endpoint");
    else if (ENDPOINT_ID.test(seedEndpoint) && BRANCH_ID.test(seedBranch)) ok("SEED_TARGET_ENDPOINT_ID matches DATABASE_URL (development) and is not forbidden");
  }

  if (offline) {
    info(`FORBIDDEN_BRANCH_IDS: ${forbiddenBranches.length} id(s); FORBIDDEN_ENDPOINT_IDS: ${forbiddenEndpoints.length} id(s) (both required for the connected check)`);
    return finish();
  }

  // 6. Connected mode preconditions — nothing below runs unless every check so far passed.
  if (!forbiddenBranches.length) bad("FORBIDDEN_BRANCH_IDS is not set — production protection is not active; refusing to connect");
  if (!forbiddenEndpoints.length) bad("FORBIDDEN_ENDPOINT_IDS is not set — production endpoints can't be refused before connecting; refusing to connect");
  if (failed) {
    deps.log("  no connection was attempted");
    return finish();
  }

  // 7. Branch identity (read-only sessions to development and test only)
  const [a, b, t] = await Promise.all([deps.identity("DATABASE_URL", dev), deps.identity("DIRECT_URL", direct), deps.identity("TEST_DATABASE_URL", test)]);
  if (!a.branch || !b.branch || !t.branch) bad("could not read neon.branch_id — cannot confirm branch identity");
  else {
    info(`development branch fingerprint ${fingerprint(a.branch)} (pooled) / ${fingerprint(b.branch)} (direct); test ${fingerprint(t.branch)}; PostgreSQL ${a.version}`);
    a.branch === b.branch ? ok("DATABASE_URL and DIRECT_URL are the same branch") : bad("DATABASE_URL and DIRECT_URL point to DIFFERENT branches");
    t.branch !== a.branch ? ok("test branch is different from development") : bad("TEST_DATABASE_URL is the SAME branch as development");
    for (const [label, id] of [["development", a.branch], ["test", t.branch]] as const) {
      if (forbiddenBranches.includes(id)) bad(`${label} branch is in FORBIDDEN_BRANCH_IDS (e.g. production) — refusing`);
    }
    // Defence in depth: the server's own endpoint id must be the one in the host and not forbidden.
    for (const [label, got, expected] of [["DATABASE_URL", a.endpoint, devEp], ["DIRECT_URL", b.endpoint, directEp], ["TEST_DATABASE_URL", t.endpoint, testEp]] as const) {
      if (got && got !== expected) bad(`${label}: server reports a different endpoint than its host name — refusing`);
      if (got && forbiddenEndpoints.includes(got)) bad(`${label}: server endpoint is in FORBIDDEN_ENDPOINT_IDS — refusing`);
    }
    if (seedBranch) {
      a.branch === seedBranch ? ok("development branch is SEED_TARGET_BRANCH_ID") : bad("development branch is NOT SEED_TARGET_BRANCH_ID — the seed would refuse");
    }
    if (!failed) ok(`neither branch is one of the ${forbiddenBranches.length} forbidden branch id(s)`);
  }
  return finish();
}

function checkPrivateStorageDir(env: Record<string, string | undefined>, cwd: string, ok: (m: string) => void, bad: (m: string) => void) {
  const dir = env.PRIVATE_STORAGE_LOCAL_DIR;
  if ((env.PRIVATE_STORAGE_DRIVER ?? "local") !== "local") return;
  if (!dir) return bad("PRIVATE_STORAGE_LOCAL_DIR not set (absolute folder outside the project; needed for uploads)");
  if (!isAbsolute(dir)) return bad("PRIVATE_STORAGE_LOCAL_DIR must be an absolute path");
  const rel = relative(resolve(cwd), resolve(dir));
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  inside ? bad("PRIVATE_STORAGE_LOCAL_DIR must be OUTSIDE the project folder") : ok("PRIVATE_STORAGE_LOCAL_DIR is absolute and outside the project");
}

/** .env.test (test-branch migrations): exactly two URLs, both on the test endpoint. Returns its URLs. */
function checkEnvTestFile(
  deps: EnvCheckDeps,
  path: string,
  devEndpoint: string,
  testEndpointFromEnv: string,
  ok: (m: string) => void,
  bad: (m: string) => void,
  info: (m: string) => void,
): [string, URL][] {
  if (!deps.exists(path)) {
    bad(".env.test not found in the project folder (NEON_SETUP_GUIDE Step 4b)");
    return [];
  }
  const vars = parseDotenv(deps.readFile(path));
  const names = Object.keys(vars).sort();
  names.join(",") === "DATABASE_URL,DIRECT_URL"
    ? ok(".env.test contains exactly DATABASE_URL and DIRECT_URL")
    : bad(`.env.test must contain exactly DATABASE_URL and DIRECT_URL (found ${names.length} variable name(s): ${names.join(", ") || "none"})`);
  let pooledUrl: URL | null = null;
  let directUrl: URL | null = null;
  try {
    pooledUrl = vars.DATABASE_URL ? new URL(vars.DATABASE_URL) : null;
    directUrl = vars.DIRECT_URL ? new URL(vars.DIRECT_URL) : null;
  } catch {
    bad(".env.test: a value is not a valid URL");
    return [];
  }
  if (!pooledUrl || !directUrl) {
    bad(".env.test: DATABASE_URL and DIRECT_URL must both be set");
    return [];
  }
  pooledUrl.hostname.includes("-pooler") ? ok(".env.test DATABASE_URL is pooled") : bad(".env.test DATABASE_URL must be the POOLED test string");
  !directUrl.hostname.includes("-pooler") ? ok(".env.test DIRECT_URL is direct") : bad(".env.test DIRECT_URL must be the DIRECT test string");
  for (const [n, u] of [["DATABASE_URL", pooledUrl], ["DIRECT_URL", directUrl]] as const) {
    const mode = u.searchParams.get("sslmode");
    if (!mode || mode === "disable" || mode === "allow") bad(`.env.test ${n}: sslmode must be require/verify-full`);
    if (/prod/i.test(u.toString())) bad(`.env.test ${n}: contains "prod" — refusing`);
  }
  const t1 = endpointOfUrl(pooledUrl);
  const t2 = endpointOfUrl(directUrl);
  info(`.env.test endpoint fingerprints: ${fingerprint(t1)} (pooled) / ${fingerprint(t2)} (direct)`);
  t1 === t2 ? ok(".env.test URLs use the same endpoint") : bad(".env.test DATABASE_URL and DIRECT_URL are on DIFFERENT endpoints");
  t1 === testEndpointFromEnv ? ok(".env.test is on the same endpoint as TEST_DATABASE_URL in .env") : bad(".env.test does not match TEST_DATABASE_URL in .env — check the Branch selector in Neon");
  t1 !== devEndpoint ? ok(".env.test is NOT the development endpoint") : bad(".env.test points to the DEVELOPMENT endpoint");
  return [
    [".env.test DATABASE_URL", pooledUrl],
    [".env.test DIRECT_URL", directUrl],
  ];
}

/** Masks anything that could be a connection string or a Neon password in an error message. */
export function sanitizeError(message: string): string {
  return message.replace(/postgres(ql)?:\/\/[^\s]+/g, "<url>").replace(/npg_[A-Za-z0-9]+/g, "***");
}
