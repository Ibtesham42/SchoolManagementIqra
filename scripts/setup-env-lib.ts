/**
 * Pure, side-effect-free logic for `npm run setup:env` (scripts/setup-env.ts). Everything that
 * decides safety lives here so it is unit-tested (tests/unit/setup-env.test.ts):
 * branch layout, endpoint ownership of each connection string, production refusal, in-place
 * .env merging, key generation without overwrites, storage location and message sanitizing.
 *
 * Nothing in this file reads files, the network or process.env.
 */
import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";

export class SetupError extends Error {}

// ───────────────────────────── Arguments ─────────────────────────────

export interface SetupArgs {
  projectId: string;
  dryRun: boolean;
  replaceUrls: boolean;
  /** Only re-prompt the seed account; no Neon calls, nothing else in .env changes. */
  seedOnly: boolean;
}

/** Neon ids are lowercase words and digits joined by dashes (e.g. flat-field-93552132). */
export const NEON_ID = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

export function parseArgs(argv: string[]): SetupArgs {
  const known = new Set(["--dry-run", "--replace-urls", "--project-id", "--seed-only"]);
  let projectId = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project-id") projectId = argv[++i] ?? "";
    else if (a.startsWith("--project-id=")) projectId = a.slice("--project-id=".length);
    else if (!known.has(a)) throw new SetupError(`Unknown option "${a.slice(0, 40)}". Use --project-id <id> [--dry-run] [--replace-urls], or --seed-only.`);
  }
  const seedOnly = argv.includes("--seed-only");
  if (seedOnly && (projectId || argv.includes("--dry-run") || argv.includes("--replace-urls"))) {
    throw new SetupError("--seed-only changes only the seed account; don't combine it with other options.");
  }
  if (!seedOnly && !NEON_ID.test(projectId)) throw new SetupError("Pass the Neon project id: --project-id <id> (e.g. flat-field-12345678).");
  return { projectId, dryRun: argv.includes("--dry-run"), replaceUrls: argv.includes("--replace-urls"), seedOnly };
}

/** Every argument handed to the neonctl shim (a shell is needed on Windows) must be inert. */
export function assertSafeCliArgs(args: string[]): void {
  for (const a of args) {
    if (!/^[A-Za-z0-9_./=-]+$/.test(a)) throw new SetupError("Refusing to pass an unexpected argument to neonctl.");
  }
}

// ───────────────────────────── Branch layout ─────────────────────────────

export interface NeonBranch {
  id: string;
  name: string;
  default?: boolean;
  parent_id?: string | null;
}
export interface NeonEndpoint {
  id: string;
  branch_id: string;
  type: string;
  host: string;
}
export interface ResolvedBranch {
  id: string;
  name: string;
  endpointId: string;
}
export interface BranchLayout {
  production: ResolvedBranch;
  development: ResolvedBranch;
  test: ResolvedBranch;
  /** Every endpoint on the production branch (all are refused). */
  productionEndpointIds: string[];
}

/**
 * Production = the project's default branch. `development` and `test` must exist by exact name,
 * be distinct, be children of production and each have exactly one read-write endpoint whose host
 * starts with its endpoint id.
 */
export function resolveBranchLayout(branches: NeonBranch[], endpoints: NeonEndpoint[]): BranchLayout {
  const defaults = branches.filter((b) => b.default);
  if (defaults.length !== 1) throw new SetupError(`Expected exactly one default (production) branch, found ${defaults.length}.`);
  const prod = defaults[0];
  const byName = (name: string) => {
    const found = branches.filter((b) => b.name === name);
    if (found.length !== 1) throw new SetupError(`Expected exactly one branch named "${name}", found ${found.length}.`);
    const b = found[0];
    if (b.id === prod.id) throw new SetupError(`The "${name}" branch is the default (production) branch — refusing.`);
    if (b.parent_id !== prod.id) throw new SetupError(`The "${name}" branch must be a child of the production branch.`);
    return b;
  };
  const dev = byName("development");
  const test = byName("test");
  if (dev.id === test.id) throw new SetupError("development and test must be different branches.");

  const endpointOf = (b: NeonBranch): string => {
    const rw = endpoints.filter((e) => e.branch_id === b.id && e.type === "read_write");
    if (rw.length !== 1) throw new SetupError(`Expected exactly one read-write endpoint on "${b.name}", found ${rw.length}.`);
    const e = rw[0];
    if (!NEON_ID.test(e.id) || !e.host.startsWith(`${e.id}.`)) throw new SetupError(`Endpoint of "${b.name}" has an unexpected host — refusing.`);
    return e.id;
  };
  const productionEndpointIds = endpoints.filter((e) => e.branch_id === prod.id).map((e) => e.id);
  return {
    production: { id: prod.id, name: prod.name, endpointId: productionEndpointIds[0] ?? "" },
    development: { id: dev.id, name: dev.name, endpointId: endpointOf(dev) },
    test: { id: test.id, name: test.name, endpointId: endpointOf(test) },
    productionEndpointIds,
  };
}

// ───────────────────────────── Connection strings ─────────────────────────────

/** Endpoint id embedded in a Neon host: "ep-x-1-pooler.region…" → "ep-x-1". */
export function endpointIdOfHost(host: string): string {
  return host.split(".")[0].replace(/-pooler$/, "");
}

/**
 * Validates a connection string fetched for `expected` and returns it normalized
 * (sslmode=verify-full, other parameters kept). Errors never contain any part of the string.
 */
export function validateConnectionString(
  raw: string,
  expected: { endpointId: string; pooled: boolean; label: string },
  productionEndpointIds: string[],
): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SetupError(`${expected.label}: neonctl did not return a valid connection string.`);
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") throw new SetupError(`${expected.label}: not a PostgreSQL connection string.`);
  const ep = endpointIdOfHost(u.hostname);
  if (productionEndpointIds.includes(ep)) throw new SetupError(`${expected.label}: string points to a PRODUCTION endpoint — refusing.`);
  if (ep !== expected.endpointId) throw new SetupError(`${expected.label}: string is for a different endpoint than the "${expected.label.split(" ")[0]}" branch — refusing.`);
  const isPooled = u.hostname.split(".")[0].endsWith("-pooler");
  if (isPooled !== expected.pooled) throw new SetupError(`${expected.label}: expected a ${expected.pooled ? "pooled" : "direct"} string.`);
  if (!u.username || !u.password) throw new SetupError(`${expected.label}: string has no credentials.`);
  if (/prod/i.test(u.hostname) || /prod/i.test(u.pathname)) throw new SetupError(`${expected.label}: contains "prod" — refusing.`);
  u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

/** Removes anything that could be a connection string or credential from a message. */
export function sanitize(message: string): string {
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi, "<masked-url>")
    .replace(/(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/gi, "$1=<masked>")
    .replace(/npg_[A-Za-z0-9]+/g, "<masked>");
}

// ───────────────────────────── .env merging ─────────────────────────────

const LINE = /^\s*([A-Z0-9_]+)\s*=(.*)$/;

/** Values of KEY= lines (first occurrence wins, like dotenv). Used only on the owner's machine. */
export function readEnvValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m && !out.has(m[1])) out.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
  return out;
}

/**
 * Writes a value so dotenv reads it back unchanged. Plain values stay unquoted; anything with `#`
 * (dotenv starts a comment there), spaces, quotes or backslashes is wrapped in a quote character
 * the value doesn't contain ('…' preferred: no escape processing).
 */
export function formatEnvValue(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new SetupError("Values may not contain line breaks or control characters.");
  if (/^[A-Za-z0-9_\-./:@%+=,?&~!*^()[\]{}|<>;]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  throw new SetupError("This value can't be stored safely in .env (it contains every kind of quote). Choose another.");
}

/**
 * Sets `updates` in an .env text, in place: the first KEY= line is replaced, duplicates are
 * removed, comments and all other lines are preserved, missing keys are appended. Keeps the
 * file's line endings.
 */
export function mergeEnv(text: string, updates: Record<string, string>): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = LINE.exec(line);
    if (m && m[1] in updates) {
      if (done.has(m[1])) continue; // drop later duplicates so dotenv can't read a stale value
      out.push(`${m[1]}=${formatEnvValue(updates[m[1]])}`);
      done.add(m[1]);
    } else out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(updates)) if (!done.has(k)) out.push(`${k}=${formatEnvValue(v)}`);
  const text2 = out.join(eol) + eol;
  // Self-check with the same parser the app uses: every value must read back exactly.
  const parsed = parseDotenv(text2);
  for (const [k, v] of Object.entries(updates)) {
    if (parsed[k] !== v) throw new SetupError(`${k} would not be read back correctly from .env — nothing was written.`);
  }
  return text2;
}

export const URL_KEYS = ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL"] as const;
export const KEY_NAMES = ["SESSION_SECRET", "DATA_ENCRYPTION_KEY", "DATA_HMAC_KEY", "DOCUMENT_VERIFICATION_KEY"] as const;

/** Refuse to silently replace database strings the owner already configured. */
export function assertUrlsReplaceable(existing: Map<string, string>, replaceUrls: boolean, file: string, keys: readonly string[]): void {
  const filled = keys.filter((k) => (existing.get(k) ?? "") !== "");
  if (filled.length && !replaceUrls) {
    throw new SetupError(`${file} already has ${filled.join(", ")}. Re-run with --replace-urls to overwrite them (keys are never overwritten).`);
  }
}

/**
 * New 32-byte base64 keys for every empty key slot; existing keys are kept (replacing them would
 * make encrypted data and issued documents unreadable). All resulting keys are distinct.
 */
export function generateMissingKeys(existing: Map<string, string>, random: (n: number) => Buffer = randomBytes): Record<string, string> {
  const result: Record<string, string> = {};
  const used = new Set(KEY_NAMES.map((k) => existing.get(k) ?? "").filter(Boolean));
  for (const k of KEY_NAMES) {
    if ((existing.get(k) ?? "") !== "") continue;
    let v = random(32).toString("base64");
    while (used.has(v)) v = random(32).toString("base64");
    used.add(v);
    result[k] = v;
  }
  if (used.size !== KEY_NAMES.length) throw new SetupError("Existing keys are not all different — fix .env by hand first.");
  return result;
}

// ───────────────────────────── Storage + seed ─────────────────────────────

export function isWithin(parent: string, child: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The configured folder if set, else <home>/SchoolERP-files; must be absolute and outside the project. */
export function resolveStorageDir(current: string | undefined, home: string, projectDir: string): string {
  const dir = current && current.trim() ? current.trim() : resolve(home, "SchoolERP-files");
  if (!isAbsolute(dir)) throw new SetupError("PRIVATE_STORAGE_LOCAL_DIR must be an absolute path.");
  if (isWithin(projectDir, dir) || isWithin(dir, projectDir)) throw new SetupError("PRIVATE_STORAGE_LOCAL_DIR must be outside the project folder.");
  return dir;
}

/**
 * Same rules the seed and the app apply (prisma/seed.ts → passwordProblem; USERNAME_PATTERN), passed
 * in so this file stays pure. Messages never include the password.
 */
export function validateSeed(
  username: string,
  password: string,
  rules: { usernamePattern: RegExp; passwordProblem: (password: string, username?: string) => string | null },
): void {
  if (/[\u0000-\u001f\u007f]/.test(password)) throw new SetupError("Password may not contain control characters.");
  if (!rules.usernamePattern.test(username)) throw new SetupError("Username: 3–50 characters — lowercase letters, digits, dot, dash or underscore.");
  const problem = rules.passwordProblem(password, username);
  if (problem) throw new SetupError(problem);
}

// ───────────────────────────── Drill branch (npm run drill:env) ─────────────────────────────

export interface DrillTarget {
  id: string;
  name: string;
  endpointId: string;
  /** Production endpoints (refused). */
  productionEndpointIds: string[];
}

/** Names that can never be a drill target, whatever the layout. */
const RESERVED_NAMES = new Set(["production", "main", "development", "test"]);

/**
 * A drill branch is a disposable CHILD OF DEVELOPMENT (schema-only or point-in-time): never the
 * default (production) branch, never development or test themselves, with exactly one read-write
 * endpoint whose host starts with its id.
 */
export function resolveDrillTarget(branches: NeonBranch[], endpoints: NeonEndpoint[], name: string): DrillTarget {
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(name)) throw new SetupError("Drill branch name: 3–40 lowercase letters, digits or dashes.");
  if (RESERVED_NAMES.has(name)) throw new SetupError(`"${name}" can't be a drill branch.`);
  const layout = resolveBranchLayout(branches, endpoints); // production/development/test must be sane too
  const found = branches.filter((b) => b.name === name);
  if (found.length !== 1) throw new SetupError(`Expected exactly one branch named "${name}", found ${found.length}.`);
  const b = found[0];
  if (b.default || b.id === layout.production.id) throw new SetupError("The drill branch is the default (production) branch — refusing.");
  if (b.id === layout.development.id || b.id === layout.test.id) throw new SetupError("The drill branch is development or test — refusing.");
  if (b.parent_id !== layout.development.id) throw new SetupError(`"${name}" must be a child of the development branch (schema-only or point-in-time).`);
  const rw = endpoints.filter((e) => e.branch_id === b.id && e.type === "read_write");
  if (rw.length !== 1) throw new SetupError(`Expected exactly one read-write endpoint on "${name}", found ${rw.length}.`);
  const e = rw[0];
  if (!NEON_ID.test(e.id) || !e.host.startsWith(`${e.id}.`)) throw new SetupError(`Endpoint of "${name}" has an unexpected host — refusing.`);
  if ([layout.development.endpointId, layout.test.endpointId, ...layout.productionEndpointIds].includes(e.id)) throw new SetupError("The drill endpoint belongs to another branch — refusing.");
  return { id: b.id, name: b.name, endpointId: e.id, productionEndpointIds: layout.productionEndpointIds };
}
