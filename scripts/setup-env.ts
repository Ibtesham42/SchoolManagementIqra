/**
 * One-time local setup of `.env` and `.env.test` from the Neon CLI — run by the OWNER in their own
 * terminal:
 *
 *   npm run setup:env -- --project-id <neon project id>            # writes the files
 *   npm run setup:env -- --project-id <neon project id> --dry-run  # read-only plan
 *   npm run setup:env -- --seed-only                               # only re-set the seed account
 *
 * Security design (docs/NEON_SETUP_GUIDE.md "Automated setup"):
 * - Refuses to write unless stdin/stdout are an interactive terminal, so agent tool sessions (which
 *   have none) can't run it. Claude Code may run only --dry-run.
 * - --dry-run never opens .env or .env.test and never requests a connection string: it only lists
 *   branches and endpoints (no secrets in either) and prints what would change.
 * - Connection strings are captured in memory from `neonctl connection-string` and validated
 *   (endpoint must belong to the branch asked for; production endpoints refused; pooled/direct
 *   checked; sslmode=verify-full). They are written only into the two git-ignored files and never
 *   printed; every error message is sanitized.
 * - Keys are generated locally (32 random bytes each) only where empty — existing keys are never
 *   overwritten. Database strings already present are only replaced with --replace-urls.
 * - Never connects to PostgreSQL, never runs SQL, never resets passwords or changes branches.
 * - This file never loads dotenv: starting it does not read .env into the process.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse as parseDotenv } from "dotenv";
import { join, resolve } from "node:path";
import {
  assertSafeCliArgs,
  assertUrlsReplaceable,
  generateMissingKeys,
  mergeEnv,
  parseArgs,
  readEnvValues,
  resolveBranchLayout,
  resolveStorageDir,
  sanitize,
  SetupError,
  URL_KEYS,
  validateConnectionString,
  validateSeed,
  type BranchLayout,
  type NeonBranch,
  type NeonEndpoint,
} from "./setup-env-lib";

/** Everything with a side effect, injectable for tests. */
export interface SetupIO {
  /** Runs neonctl and returns stdout (never logged). */
  neon(args: string[]): string;
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFileAtomic(path: string, text: string): void;
  mkdirp(path: string): void;
  isInteractive(): boolean;
  prompt(question: string): Promise<string>;
  promptHidden(question: string): Promise<string>;
  log(line: string): void;
  runOfflineCheck(): number;
  home: string;
  cwd: string;
  passwordProblem(password: string, username?: string): string | null;
  usernamePattern: RegExp;
}

const ENV = ".env";
const ENV_TEST = ".env.test";
const EXAMPLE = ".env.example";

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SetupError(`Unexpected ${what} output from neonctl (not shown).`);
  }
}

export function discoverRaw(io: SetupIO, projectId: string): { branches: NeonBranch[]; endpoints: NeonEndpoint[] } {
  const branchesJson = parseJson<NeonBranch[] | { branches: NeonBranch[] }>(io.neon(["branches", "list", "--project-id", projectId, "--output", "json"]), "branch list");
  const endpointsJson = parseJson<{ endpoints: NeonEndpoint[] }>(io.neon(["api", `/projects/${projectId}/endpoints`]), "endpoint list");
  return { branches: (Array.isArray(branchesJson) ? branchesJson : branchesJson.branches) ?? [], endpoints: endpointsJson.endpoints ?? [] };
}

export function discoverLayout(io: SetupIO, projectId: string): BranchLayout {
  const branchesJson = parseJson<NeonBranch[] | { branches: NeonBranch[] }>(io.neon(["branches", "list", "--project-id", projectId, "--output", "json"]), "branch list");
  const branches = Array.isArray(branchesJson) ? branchesJson : branchesJson.branches;
  const endpointsJson = parseJson<{ endpoints: NeonEndpoint[] }>(io.neon(["api", `/projects/${projectId}/endpoints`]), "endpoint list");
  return resolveBranchLayout(branches ?? [], endpointsJson.endpoints ?? []);
}

function fetchUrl(io: SetupIO, projectId: string, layout: BranchLayout, which: "development" | "test", pooled: boolean): string {
  const branch = layout[which];
  const args = ["connection-string", branch.id, "--project-id", projectId, "--ssl", "verify-full"];
  if (pooled) args.push("--pooled");
  // Take the first postgres URL from stdout (ignores banners/whitespace); never echo what was received.
  const raw = io.neon(args).match(/postgres(?:ql)?:\/\/[^\s"'`]+/)?.[0];
  if (!raw) throw new SetupError(`${which} ${pooled ? "pooled" : "direct"}: neonctl returned no connection string.`);
  return validateConnectionString(raw, { endpointId: branch.endpointId, pooled, label: `${which} ${pooled ? "pooled" : "direct"}` }, layout.productionEndpointIds);
}

/** Asks for the first Super Admin; returns the two .env values, or null if skipped. */
async function promptSeed(io: SetupIO): Promise<Record<string, string> | null> {
  const username = (await io.prompt("First Super Admin username (lowercase; Enter to skip): ")).trim().toLowerCase();
  if (!username) return null;
  const password = await io.promptHidden("Password (hidden, 10+ characters): ");
  const again = await io.promptHidden("Repeat password: ");
  if (password !== again) throw new SetupError("Passwords did not match — nothing was written.");
  validateSeed(username, password, { usernamePattern: io.usernamePattern, passwordProblem: io.passwordProblem });
  return { SEED_SUPERADMIN_USERNAME: username, SEED_SUPERADMIN_PASSWORD: password };
}

/** --seed-only: no Neon calls; only the two SEED_SUPERADMIN_* lines of an existing .env change. */
async function runSeedOnly(io: SetupIO): Promise<number> {
  if (!io.isInteractive()) throw new SetupError("--seed-only asks for a password and must be run by you in an interactive terminal.");
  const envPath = resolve(io.cwd, ENV);
  if (!io.exists(envPath)) throw new SetupError(".env not found — run the full setup first.");
  const before = io.readFile(envPath);
  const seed = await promptSeed(io);
  if (!seed) {
    io.log("• Nothing changed (seed account skipped).");
    return 0;
  }
  const after = mergeEnv(before, seed);
  // Every other variable must read back exactly as before (checked with dotenv, the app's parser).
  const a = parseDotenv(before);
  const b = parseDotenv(after);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in seed) && a[k] !== b[k]) throw new SetupError(`${k} would change — nothing was written.`);
  }
  io.writeFileAtomic(envPath, after);
  io.log("✓ .env: SEED_SUPERADMIN_USERNAME and SEED_SUPERADMIN_PASSWORD updated; nothing else changed");
  io.log("Running the offline check (no connections)…");
  return io.runOfflineCheck();
}

export async function runSetup(argv: string[], io: SetupIO): Promise<number> {
  const args = parseArgs(argv);
  if (args.seedOnly) return runSeedOnly(io);
  const layout = discoverLayout(io, args.projectId);
  io.log(`✓ production (default) branch ${layout.production.id} — will be FORBIDDEN, never targeted`);
  io.log(`✓ development branch ${layout.development.id} (endpoint ${layout.development.endpointId})`);
  io.log(`✓ test branch ${layout.test.id} (endpoint ${layout.test.endpointId})`);
  io.log(`✓ ${layout.productionEndpointIds.length} production endpoint(s) will be refused`);

  if (args.dryRun) {
    io.log("Dry run — would set (values are never printed):");
    io.log("  .env:      DATABASE_URL (development, pooled), DIRECT_URL (development, direct), TEST_DATABASE_URL (test, pooled)");
    io.log(`  .env:      FORBIDDEN_BRANCH_IDS (production branch), FORBIDDEN_ENDPOINT_IDS (production endpoints), SEED_TARGET_* (development branch + endpoint), keys that are still empty (4 slots), PRIVATE_STORAGE_LOCAL_DIR if empty (→ ${join(io.home, "SchoolERP-files")}), SEED_SUPERADMIN_* if empty (prompted)`);
    io.log("  .env.test: DATABASE_URL (test, pooled), DIRECT_URL (test, direct)");
    io.log("Dry run: .env and .env.test were not opened, no connection string was requested, nothing was written.");
    return 0;
  }

  if (!io.isInteractive()) {
    throw new SetupError("setup:env writes secrets and must be run by you in an interactive terminal (PowerShell or Git Bash), not by an automated tool. Use --dry-run to preview.");
  }

  // Existing files: never silently replace configured database strings.
  const envPath = resolve(io.cwd, ENV);
  const envTestPath = resolve(io.cwd, ENV_TEST);
  let envText = io.exists(envPath) ? io.readFile(envPath) : io.readFile(resolve(io.cwd, EXAMPLE));
  const values = readEnvValues(envText);
  assertUrlsReplaceable(values, args.replaceUrls, ENV, URL_KEYS);
  if (io.exists(envTestPath)) assertUrlsReplaceable(readEnvValues(io.readFile(envTestPath)), args.replaceUrls, ENV_TEST, ["DATABASE_URL", "DIRECT_URL"]);

  // Connection strings: in memory only, each tied to its branch's endpoint.
  const devPooled = fetchUrl(io, args.projectId, layout, "development", true);
  const devDirect = fetchUrl(io, args.projectId, layout, "development", false);
  const testPooled = fetchUrl(io, args.projectId, layout, "test", true);
  const testDirect = fetchUrl(io, args.projectId, layout, "test", false);
  io.log("✓ 4 connection strings retrieved and verified against their branch endpoints (not shown)");

  const keys = generateMissingKeys(values);
  const storage = resolveStorageDir(values.get("PRIVATE_STORAGE_LOCAL_DIR"), io.home, io.cwd);
  io.mkdirp(storage);

  const updates: Record<string, string> = {
    DATABASE_URL: devPooled,
    DIRECT_URL: devDirect,
    TEST_DATABASE_URL: testPooled,
    FORBIDDEN_BRANCH_IDS: [...new Set([...(values.get("FORBIDDEN_BRANCH_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean), layout.production.id])].join(","),
    FORBIDDEN_ENDPOINT_IDS: [...new Set([...(values.get("FORBIDDEN_ENDPOINT_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean), ...layout.productionEndpointIds])].join(","),
    // Seed allow-list (ADR-032): the seed writes only to the development branch.
    SEED_TARGET_BRANCH_ID: layout.development.id,
    SEED_TARGET_ENDPOINT_ID: layout.development.endpointId,
    PRIVATE_STORAGE_LOCAL_DIR: storage,
    ...keys,
  };

  const seedUser = values.get("SEED_SUPERADMIN_USERNAME") ?? "";
  const seedPass = values.get("SEED_SUPERADMIN_PASSWORD") ?? "";
  if (!seedUser || !seedPass) {
    const seed = await promptSeed(io);
    if (seed) Object.assign(updates, seed);
    else io.log("• Seed account skipped — set it later with: npm run setup:env -- --seed-only");
  }

  envText = mergeEnv(envText, updates);
  const envTestText = mergeEnv(
    "# Test branch ONLY (written by npm run setup:env). Used via DOTENV_PATH=.env.test for test-branch migrations.\n",
    { DATABASE_URL: testPooled, DIRECT_URL: testDirect },
  );
  io.writeFileAtomic(envPath, envText);
  io.writeFileAtomic(envTestPath, envTestText);

  io.log(`✓ .env written: DATABASE_URL, DIRECT_URL, TEST_DATABASE_URL, FORBIDDEN_BRANCH_IDS, FORBIDDEN_ENDPOINT_IDS, SEED_TARGET_BRANCH_ID, SEED_TARGET_ENDPOINT_ID, PRIVATE_STORAGE_LOCAL_DIR${updates.SEED_SUPERADMIN_USERNAME ? ", SEED_SUPERADMIN_*" : ""}`);
  io.log(`✓ keys: ${Object.keys(keys).length} generated, ${4 - Object.keys(keys).length} existing kept`);
  io.log("✓ .env.test written: DATABASE_URL, DIRECT_URL (test branch)");
  io.log(`✓ private storage folder ready (outside the project)`);
  io.log("! Copy DATA_ENCRYPTION_KEY and DOCUMENT_VERIFICATION_KEY from .env into your password manager.");
  io.log("Running the offline check (no connections)…");
  return io.runOfflineCheck();
}

// ───────────────────────────── Real I/O ─────────────────────────────

function readHidden(question: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolvePromise(value);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          return reject(new SetupError("Cancelled — nothing was written."));
        }
        if (ch === "\u0008" || ch === "\u007f") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function readLine(question: string): Promise<string> {
  return new Promise((resolvePromise) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d: string) => {
      process.stdin.pause();
      resolvePromise(d.split(/\r?\n/)[0]);
    });
  });
}

/** Real side effects (also used by scripts/drill-env.ts). */
export async function realIO(): Promise<SetupIO> {
  const { passwordProblem } = await import("../src/lib/auth/password");
  const { USERNAME_PATTERN } = await import("../src/modules/identity/identity.schemas");
  return {
    neon(args) {
      const full = [...args, "--no-analytics"];
      assertSafeCliArgs(full);
      const r = spawnSync("neonctl", full, {
        shell: process.platform === "win32", // the npm shim is a .cmd on Windows; arguments are validated above
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        env: { ...process.env, MSYS_NO_PATHCONV: "1" }, // keep "/projects/…" API paths intact under Git Bash
      });
      if (r.error || r.status !== 0) {
        const err = sanitize(`${r.stderr ?? ""}${r.error ? ` ${r.error.message}` : ""}`).trim();
        if (/Awaiting authentication/i.test(err)) throw new SetupError("Neon CLI is not signed in for this terminal — run `neonctl auth` first.");
        throw new SetupError(`neonctl ${args[0]} failed${err ? `: ${err.slice(0, 200)}` : ""}`);
      }
      return r.stdout;
    },
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, "utf8"),
    writeFileAtomic(p, text) {
      const tmp = `${p}.setup-tmp`;
      writeFileSync(tmp, text, { encoding: "utf8", flag: "w" });
      renameSync(tmp, p);
    },
    mkdirp: (p) => void mkdirSync(p, { recursive: true }),
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: readLine,
    promptHidden: readHidden,
    log: (line) => console.log(line),
    runOfflineCheck: () =>
      spawnSync("npm", ["run", "env:check:offline"], { shell: process.platform === "win32", stdio: "inherit" }).status ?? 1,
    home: homedir(),
    cwd: process.cwd(),
    passwordProblem,
    usernamePattern: USERNAME_PATTERN,
  };
}

if (process.argv[1] && /setup-env\.ts$/.test(process.argv[1])) {
  realIO()
    .then((io) => runSetup(process.argv.slice(2), io))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      console.error(`✗ ${sanitize(e instanceof Error ? e.message : String(e))}`);
      process.exitCode = 1;
    });
}
