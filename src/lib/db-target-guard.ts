/**
 * Fail-closed database target guard for scripts that WRITE outside a migration (the seed — ADR-032).
 *
 * The guard decides, before any write, that the database about to be written is exactly the one
 * the owner allow-listed:
 *   1. the shell must not pre-set DOTENV_PATH/DOTENV_CONFIG_PATH or any database URL (a shell value
 *      silently overrides .env and could redirect the run);
 *   2. SEED_TARGET_BRANCH_ID / SEED_TARGET_ENDPOINT_ID (allow-list) and FORBIDDEN_BRANCH_IDS /
 *      FORBIDDEN_ENDPOINT_IDS (deny-list) are all required and well-formed, and the allow-list
 *      must not be forbidden;
 *   3. from the URL host alone (no connection): DATABASE_URL's endpoint equals the allow-listed
 *      endpoint, is not forbidden and is not the test endpoint (TEST_DATABASE_URL);
 *   4. live: the server's own neon.branch_id / neon.endpoint_id equal the allow-list (checked in a
 *      read-only session first, then again inside the write transaction).
 * Every refusal throws TargetGuardError naming variables only — never values or URLs.
 *
 * Pure functions only; reading process.env, connecting and querying are the caller's job.
 */

export class TargetGuardError extends Error {}

export const ENDPOINT_ID = /^ep-[a-z0-9]+(?:-[a-z0-9]+)+$/;
export const BRANCH_ID = /^br-[a-z0-9]+(?:-[a-z0-9]+)+$/;

/** Variables that must NOT come from the shell when a guarded script starts. */
export const SHELL_OVERRIDE_VARS = ["DOTENV_PATH", "DOTENV_CONFIG_PATH", "DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL"] as const;

/** Read-only identity query (Neon settings). Same text for the pre-check and the in-transaction check. */
export const IDENTITY_SQL =
  "SELECT current_setting('neon.branch_id', true) AS branch, current_setting('neon.endpoint_id', true) AS endpoint";

export interface DbIdentity {
  branch: string | null;
  endpoint: string | null;
}

export interface SeedTarget {
  branchId: string;
  endpointId: string;
  forbiddenBranchIds: string[];
  forbiddenEndpointIds: string[];
}

export function parseIdList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** "ep-cool-name-123456" from "ep-cool-name-123456-pooler.region.aws.neon.tech" — no credentials involved. */
export function endpointOfUrl(u: URL): string {
  return u.hostname.split(".")[0].replace(/-pooler$/, "");
}

/** Step 1 — call with the environment captured BEFORE any .env file is loaded. */
export function assertShellClean(shellEnv: Record<string, string | undefined>): void {
  const set = SHELL_OVERRIDE_VARS.filter((k) => (shellEnv[k] ?? "") !== "");
  if (set.length) {
    throw new TargetGuardError(
      `Refusing to run: ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set in the shell. The seed reads only the project's .env — open a new terminal (or Remove-Item Env:<name>) and run it again.`,
    );
  }
}

/** Steps 2 and 3 — decides the target from configuration and the URL host alone (no connection). */
export function resolveSeedTarget(env: Record<string, string | undefined>): SeedTarget {
  const problems: string[] = [];
  const branchId = (env.SEED_TARGET_BRANCH_ID ?? "").trim();
  const endpointId = (env.SEED_TARGET_ENDPOINT_ID ?? "").trim();
  const forbiddenBranchIds = parseIdList(env.FORBIDDEN_BRANCH_IDS);
  const forbiddenEndpointIds = parseIdList(env.FORBIDDEN_ENDPOINT_IDS);

  if (!branchId) problems.push("SEED_TARGET_BRANCH_ID is not set");
  else if (!BRANCH_ID.test(branchId)) problems.push("SEED_TARGET_BRANCH_ID is not a Neon branch id (br-…)");
  if (!endpointId) problems.push("SEED_TARGET_ENDPOINT_ID is not set");
  else if (!ENDPOINT_ID.test(endpointId)) problems.push("SEED_TARGET_ENDPOINT_ID is not a Neon endpoint id (ep-…)");
  if (!forbiddenBranchIds.length) problems.push("FORBIDDEN_BRANCH_IDS is not set");
  if (!forbiddenEndpointIds.length) problems.push("FORBIDDEN_ENDPOINT_IDS is not set");
  if (forbiddenBranchIds.some((id) => !BRANCH_ID.test(id))) problems.push("FORBIDDEN_BRANCH_IDS contains a value that is not a branch id");
  if (forbiddenEndpointIds.some((id) => !ENDPOINT_ID.test(id))) problems.push("FORBIDDEN_ENDPOINT_IDS contains a value that is not an endpoint id");
  if (branchId && forbiddenBranchIds.includes(branchId)) problems.push("SEED_TARGET_BRANCH_ID is listed in FORBIDDEN_BRANCH_IDS");
  if (endpointId && forbiddenEndpointIds.includes(endpointId)) problems.push("SEED_TARGET_ENDPOINT_ID is listed in FORBIDDEN_ENDPOINT_IDS");

  let url: URL | null = null;
  try {
    url = env.DATABASE_URL ? new URL(env.DATABASE_URL) : null;
  } catch {
    problems.push("DATABASE_URL is not a valid URL");
  }
  if (!env.DATABASE_URL) problems.push("DATABASE_URL is not set");
  if (url) {
    const ep = endpointOfUrl(url);
    if (forbiddenEndpointIds.includes(ep)) problems.push("DATABASE_URL points to a FORBIDDEN endpoint (e.g. production)");
    else if (endpointId && ep !== endpointId) problems.push("DATABASE_URL does not point to SEED_TARGET_ENDPOINT_ID (unknown or wrong endpoint)");
    let testEp: string | null = null;
    try {
      testEp = env.TEST_DATABASE_URL ? endpointOfUrl(new URL(env.TEST_DATABASE_URL)) : null;
    } catch {
      problems.push("TEST_DATABASE_URL is not a valid URL");
    }
    if (testEp && ep === testEp) problems.push("DATABASE_URL points to the TEST endpoint");
    if (testEp && endpointId && endpointId === testEp) problems.push("SEED_TARGET_ENDPOINT_ID is the TEST endpoint");
  }
  if (problems.length) throw new TargetGuardError(`Refusing to seed — ${problems.join("; ")}. Nothing was written.`);
  return { branchId, endpointId, forbiddenBranchIds, forbiddenEndpointIds };
}

/** Step 4 — the server's own identity must be exactly the allow-listed branch and endpoint. */
export function assertLiveIdentity(id: DbIdentity | undefined | null, target: SeedTarget): void {
  if (!id || !id.branch || !id.endpoint) {
    throw new TargetGuardError("Refusing to seed — the server did not report a Neon branch/endpoint id, so its identity can't be confirmed. Nothing was written.");
  }
  if (target.forbiddenBranchIds.includes(id.branch) || target.forbiddenEndpointIds.includes(id.endpoint)) {
    throw new TargetGuardError("Refusing to seed — the server is a FORBIDDEN branch/endpoint (e.g. production). Nothing was written.");
  }
  if (id.branch !== target.branchId || id.endpoint !== target.endpointId) {
    throw new TargetGuardError("Refusing to seed — the server is not SEED_TARGET_BRANCH_ID / SEED_TARGET_ENDPOINT_ID. Nothing was written.");
  }
}

// ───────────────────────────── Test-run targets (S-05 integration, S-06 e2e) ─────────────────────────────

export interface RunTargetSpec {
  /** Shown in refusals, e.g. "integration tests". */
  label: string;
  /** Variable holding the database URL the run will WRITE to. */
  urlVar: string;
  /** Allow-list variables: the exact Neon branch / endpoint the run may write to. */
  branchVar: string;
  endpointVar: string;
  /** Integration tests must never touch development (its endpoint is SEED_TARGET_ENDPOINT_ID). */
  refuseDevelopment: boolean;
}

export const INTEGRATION_TARGET: RunTargetSpec = { label: "integration tests", urlVar: "TEST_DATABASE_URL", branchVar: "TEST_TARGET_BRANCH_ID", endpointVar: "TEST_TARGET_ENDPOINT_ID", refuseDevelopment: true };
export const E2E_TARGET: RunTargetSpec = { label: "e2e setup", urlVar: "E2E_DATABASE_URL", branchVar: "E2E_TARGET_BRANCH_ID", endpointVar: "E2E_TARGET_ENDPOINT_ID", refuseDevelopment: false };

/**
 * Same fail-closed rules as the seed, for test runs that write: an explicit branch + endpoint allow-list,
 * forbidden ids required and never targeted, the URL host must be the allow-listed endpoint, and (for
 * integration tests) never the development endpoint. Pure — decided from configuration and the URL host.
 */
export function resolveRunTarget(env: Record<string, string | undefined>, spec: RunTargetSpec): SeedTarget {
  const problems: string[] = [];
  const branchId = (env[spec.branchVar] ?? "").trim();
  const endpointId = (env[spec.endpointVar] ?? "").trim();
  const forbiddenBranchIds = parseIdList(env.FORBIDDEN_BRANCH_IDS);
  const forbiddenEndpointIds = parseIdList(env.FORBIDDEN_ENDPOINT_IDS);
  const devEndpoint = (env.SEED_TARGET_ENDPOINT_ID ?? "").trim();
  const devBranch = (env.SEED_TARGET_BRANCH_ID ?? "").trim();

  if (!branchId) problems.push(`${spec.branchVar} is not set`);
  else if (!BRANCH_ID.test(branchId)) problems.push(`${spec.branchVar} is not a Neon branch id (br-…)`);
  if (!endpointId) problems.push(`${spec.endpointVar} is not set`);
  else if (!ENDPOINT_ID.test(endpointId)) problems.push(`${spec.endpointVar} is not a Neon endpoint id (ep-…)`);
  if (!forbiddenBranchIds.length) problems.push("FORBIDDEN_BRANCH_IDS is not set");
  if (!forbiddenEndpointIds.length) problems.push("FORBIDDEN_ENDPOINT_IDS is not set");
  if (forbiddenBranchIds.some((id) => !BRANCH_ID.test(id))) problems.push("FORBIDDEN_BRANCH_IDS contains a value that is not a branch id");
  if (forbiddenEndpointIds.some((id) => !ENDPOINT_ID.test(id))) problems.push("FORBIDDEN_ENDPOINT_IDS contains a value that is not an endpoint id");
  if (branchId && forbiddenBranchIds.includes(branchId)) problems.push(`${spec.branchVar} is listed in FORBIDDEN_BRANCH_IDS`);
  if (endpointId && forbiddenEndpointIds.includes(endpointId)) problems.push(`${spec.endpointVar} is listed in FORBIDDEN_ENDPOINT_IDS`);
  if (spec.refuseDevelopment) {
    if (!devEndpoint || !devBranch) problems.push("SEED_TARGET_BRANCH_ID / SEED_TARGET_ENDPOINT_ID (development) must be set so it can be refused");
    if (devEndpoint && endpointId === devEndpoint) problems.push(`${spec.endpointVar} is the DEVELOPMENT endpoint`);
    if (devBranch && branchId === devBranch) problems.push(`${spec.branchVar} is the DEVELOPMENT branch`);
  }

  const raw = env[spec.urlVar];
  if (!raw) problems.push(`${spec.urlVar} is not set`);
  else {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`${spec.urlVar} is not a valid URL`);
    }
    if (url) {
      const ep = endpointOfUrl(url);
      if (forbiddenEndpointIds.includes(ep)) problems.push(`${spec.urlVar} points to a FORBIDDEN endpoint (e.g. production)`);
      else if (endpointId && ep !== endpointId) problems.push(`${spec.urlVar} does not point to ${spec.endpointVar}`);
      if (spec.refuseDevelopment && devEndpoint && ep === devEndpoint) problems.push(`${spec.urlVar} points to the DEVELOPMENT endpoint`);
    }
  }
  if (problems.length) throw new TargetGuardError(`Refusing to run ${spec.label} — ${problems.join("; ")}. Nothing was written.`);
  return { branchId, endpointId, forbiddenBranchIds, forbiddenEndpointIds };
}

/** Live check for a test run: the server's own identity must be exactly the allow-listed branch/endpoint. */
export function assertRunIdentity(id: DbIdentity | undefined | null, target: SeedTarget, spec: RunTargetSpec): void {
  if (!id || !id.branch || !id.endpoint) throw new TargetGuardError(`Refusing to run ${spec.label} — the server did not report a Neon branch/endpoint id. Nothing was written.`);
  if (target.forbiddenBranchIds.includes(id.branch) || target.forbiddenEndpointIds.includes(id.endpoint)) {
    throw new TargetGuardError(`Refusing to run ${spec.label} — the server is a FORBIDDEN branch/endpoint (e.g. production). Nothing was written.`);
  }
  if (id.branch !== target.branchId || id.endpoint !== target.endpointId) {
    throw new TargetGuardError(`Refusing to run ${spec.label} — the server is not ${spec.branchVar} / ${spec.endpointVar}. Nothing was written.`);
  }
}
