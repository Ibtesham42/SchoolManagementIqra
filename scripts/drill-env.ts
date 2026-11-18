/**
 * Writes `.env.restore.local` for a disposable drill branch (ADR-033) — run by the OWNER:
 *
 *   npm run drill:env -- --project-id <id> --branch <drill branch name> [--dry-run] [--replace]
 *
 * - The branch must be a child of development (schema-only or point-in-time), never production,
 *   development or test, with exactly one read-write endpoint (scripts/setup-env-lib
 *   resolveDrillTarget).
 * - Connection strings are fetched into memory from `neonctl connection-string`, checked against
 *   the drill branch's endpoint (production endpoints refused) and written only to
 *   `.env.restore.local` — git-ignored (`.env.*`) and on Claude Code's deny list (`.env.*.local`).
 * - Refuses without an interactive terminal (except --dry-run, which requests no strings and
 *   writes nothing). Never prints values; never connects to PostgreSQL.
 */
import { resolve } from "node:path";
import { mergeEnv, NEON_ID, resolveDrillTarget, sanitize, SetupError, validateConnectionString } from "./setup-env-lib";
import { discoverRaw, realIO, type SetupIO } from "./setup-env";

export const RESTORE_ENV_FILE = ".env.restore.local";

export interface DrillEnvArgs {
  projectId: string;
  branch: string;
  dryRun: boolean;
  replace: boolean;
}

export function parseDrillEnvArgs(argv: string[]): DrillEnvArgs {
  let projectId = "";
  let branch = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project-id") projectId = argv[++i] ?? "";
    else if (a === "--branch") branch = argv[++i] ?? "";
    else if (a !== "--dry-run" && a !== "--replace") throw new SetupError(`Unknown option "${a.slice(0, 40)}". Use --project-id <id> --branch <name> [--dry-run] [--replace].`);
  }
  if (!NEON_ID.test(projectId)) throw new SetupError("Pass the Neon project id: --project-id <id>.");
  if (!branch) throw new SetupError("Pass the drill branch name: --branch <name>.");
  return { projectId, branch, dryRun: argv.includes("--dry-run"), replace: argv.includes("--replace") };
}

export async function runDrillEnv(argv: string[], io: SetupIO): Promise<number> {
  const args = parseDrillEnvArgs(argv);
  const { branches, endpoints } = discoverRaw(io, args.projectId);
  const target = resolveDrillTarget(branches, endpoints, args.branch);
  io.log(`✓ drill branch ${target.name} (${target.id}), endpoint ${target.endpointId} — child of development, not production/development/test`);
  if (args.dryRun) {
    io.log(`Dry run — would write ${RESTORE_ENV_FILE}: DATABASE_URL (pooled), DIRECT_URL (direct), DRILL_TARGET_BRANCH_ID, DRILL_TARGET_ENDPOINT_ID. No connection string was requested; nothing was written.`);
    return 0;
  }
  if (!io.isInteractive()) throw new SetupError("drill:env writes connection strings and must be run by you in an interactive terminal. Use --dry-run to preview.");
  const path = resolve(io.cwd, RESTORE_ENV_FILE);
  if (io.exists(path) && !args.replace) throw new SetupError(`${RESTORE_ENV_FILE} already exists. Re-run with --replace to overwrite it.`);

  const fetch = (pooled: boolean) => {
    const cliArgs = ["connection-string", target.id, "--project-id", args.projectId, "--ssl", "verify-full"];
    if (pooled) cliArgs.push("--pooled");
    const raw = io.neon(cliArgs).match(/postgres(?:ql)?:\/\/[^\s"'`]+/)?.[0];
    if (!raw) throw new SetupError(`drill ${pooled ? "pooled" : "direct"}: neonctl returned no connection string.`);
    return validateConnectionString(raw, { endpointId: target.endpointId, pooled, label: `drill ${pooled ? "pooled" : "direct"}` }, target.productionEndpointIds);
  };
  const pooled = fetch(true);
  const direct = fetch(false);
  const text = mergeEnv(`# Disposable drill branch ONLY (written by npm run drill:env). Delete after the drill.\n`, {
    DATABASE_URL: pooled,
    DIRECT_URL: direct,
    DRILL_TARGET_BRANCH_ID: target.id,
    DRILL_TARGET_ENDPOINT_ID: target.endpointId,
  });
  io.writeFileAtomic(path, text);
  io.log(`✓ ${RESTORE_ENV_FILE} written: DATABASE_URL, DIRECT_URL, DRILL_TARGET_BRANCH_ID, DRILL_TARGET_ENDPOINT_ID (values not shown)`);
  return 0;
}

if (process.argv[1] && /drill-env\.ts$/.test(process.argv[1])) {
  realIO()
    .then((io) => runDrillEnv(process.argv.slice(2), io))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      console.error(`✗ ${sanitize(e instanceof Error ? e.message : String(e))}`);
      process.exitCode = 1;
    });
}
