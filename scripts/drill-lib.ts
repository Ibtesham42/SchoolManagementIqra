/**
 * Pure logic for the backup/restore drill (`npm run backup:drill`, ADR-033) and the drill
 * credentials helper (`npm run drill:env`). Unit-tested in tests/unit/backup-drill.test.ts.
 *
 * Rules (all fail closed; messages name variables, never values or URLs):
 * - SOURCE = development: `.env` DIRECT_URL, whose endpoint must equal the development allow-list
 *   SEED_TARGET_ENDPOINT_ID (live branch = SEED_TARGET_BRANCH_ID). Read in a READ-ONLY session.
 * - TARGET = a disposable drill branch: `.env.restore.local` DIRECT_URL, whose endpoint must equal
 *   DRILL_TARGET_ENDPOINT_ID (live branch = DRILL_TARGET_BRANCH_ID) — never forbidden, never the
 *   development or test endpoint, never the source.
 * - No connection strings on the command line.
 * - A backup file is written only when explicitly requested, encrypted (AES-256-GCM, key from a
 *   passphrase via scrypt), to an absolute path outside the project and the private file store.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { BRANCH_ID, ENDPOINT_ID, endpointOfUrl, parseIdList, TargetGuardError, type SeedTarget } from "../src/lib/db-target-guard";

export class DrillError extends Error {}

// ───────────────────────────── Arguments ─────────────────────────────

export interface DrillArgs {
  /** Absolute path for an encrypted backup file, or null (in-memory only, the default). */
  out: string | null;
}

export function parseDrillArgs(argv: string[]): DrillArgs {
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/:\/\//.test(a) || /^postgres/i.test(a)) throw new DrillError("Connection strings are not accepted on the command line — the drill reads .env and .env.restore.local.");
    if (a === "--out") out = argv[++i] ?? "";
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else throw new DrillError(`Unknown option "${a.slice(0, 40)}". Use [--out <absolute path>].`);
  }
  if (out !== null && !out.trim()) throw new DrillError("--out needs an absolute path.");
  return { out };
}

// ───────────────────────────── Source / target resolution ─────────────────────────────

export interface DrillPlan {
  sourceUrl: string;
  targetUrl: string;
  source: SeedTarget;
  target: SeedTarget;
}

const endpointOrNull = (raw: string | undefined): string | null => {
  try {
    return raw ? endpointOfUrl(new URL(raw)) : null;
  } catch {
    return null;
  }
};

/**
 * Decides source and target from `.env` (`devEnv`) and `.env.restore.local` (`restoreEnv`) without
 * connecting. Returns the two URLs only to the caller (never logged).
 */
export function resolveDrillPlan(devEnv: Record<string, string | undefined>, restoreEnv: Record<string, string | undefined>): DrillPlan {
  const problems: string[] = [];
  const forbiddenBranchIds = parseIdList(devEnv.FORBIDDEN_BRANCH_IDS);
  const forbiddenEndpointIds = parseIdList(devEnv.FORBIDDEN_ENDPOINT_IDS);
  if (!forbiddenBranchIds.length) problems.push("FORBIDDEN_BRANCH_IDS is not set in .env");
  if (!forbiddenEndpointIds.length) problems.push("FORBIDDEN_ENDPOINT_IDS is not set in .env");

  const srcBranch = (devEnv.SEED_TARGET_BRANCH_ID ?? "").trim();
  const srcEndpoint = (devEnv.SEED_TARGET_ENDPOINT_ID ?? "").trim();
  if (!BRANCH_ID.test(srcBranch)) problems.push("SEED_TARGET_BRANCH_ID (development allow-list) is missing or malformed in .env");
  if (!ENDPOINT_ID.test(srcEndpoint)) problems.push("SEED_TARGET_ENDPOINT_ID (development allow-list) is missing or malformed in .env");

  const tgtBranch = (restoreEnv.DRILL_TARGET_BRANCH_ID ?? "").trim();
  const tgtEndpoint = (restoreEnv.DRILL_TARGET_ENDPOINT_ID ?? "").trim();
  if (!BRANCH_ID.test(tgtBranch)) problems.push("DRILL_TARGET_BRANCH_ID is missing or malformed in .env.restore.local");
  if (!ENDPOINT_ID.test(tgtEndpoint)) problems.push("DRILL_TARGET_ENDPOINT_ID is missing or malformed in .env.restore.local");

  const sourceUrl = devEnv.DIRECT_URL ?? "";
  const targetUrl = restoreEnv.DIRECT_URL ?? "";
  const srcEp = endpointOrNull(sourceUrl);
  const tgtEp = endpointOrNull(targetUrl);
  const devPooledEp = endpointOrNull(devEnv.DATABASE_URL);
  const testEp = endpointOrNull(devEnv.TEST_DATABASE_URL);
  if (!srcEp) problems.push("DIRECT_URL in .env is missing or not a URL");
  if (!tgtEp) problems.push("DIRECT_URL in .env.restore.local is missing or not a URL");

  if (srcEp && srcEndpoint && srcEp !== srcEndpoint) problems.push("SOURCE (.env DIRECT_URL) is not the development allow-list endpoint");
  if (tgtEp && tgtEndpoint && tgtEp !== tgtEndpoint) problems.push("TARGET (.env.restore.local DIRECT_URL) is not DRILL_TARGET_ENDPOINT_ID");
  for (const [label, ep] of [["SOURCE", srcEp], ["TARGET", tgtEp]] as const) {
    if (ep && forbiddenEndpointIds.includes(ep)) problems.push(`${label} is a FORBIDDEN endpoint (e.g. production)`);
  }
  if (tgtEp && (tgtEp === srcEp || tgtEp === devPooledEp || tgtEp === srcEndpoint)) problems.push("TARGET is the development endpoint — the drill never restores into development");
  if (tgtEp && testEp && tgtEp === testEp) problems.push("TARGET is the test endpoint — the drill never restores into the test branch");
  if (tgtBranch && (forbiddenBranchIds.includes(tgtBranch) || tgtBranch === srcBranch)) problems.push("DRILL_TARGET_BRANCH_ID is forbidden or is the development branch");
  if (tgtEndpoint && forbiddenEndpointIds.includes(tgtEndpoint)) problems.push("DRILL_TARGET_ENDPOINT_ID is listed in FORBIDDEN_ENDPOINT_IDS");

  if (problems.length) throw new DrillError(`Refusing to run the drill — ${problems.join("; ")}. Nothing was read or written.`);
  return {
    sourceUrl,
    targetUrl,
    source: { branchId: srcBranch, endpointId: srcEndpoint, forbiddenBranchIds, forbiddenEndpointIds },
    target: { branchId: tgtBranch, endpointId: tgtEndpoint, forbiddenBranchIds, forbiddenEndpointIds },
  };
}

/** The source session must report transaction_read_only = on before anything is read. */
export function assertReadOnly(setting: string | undefined | null): void {
  if (setting !== "on") throw new TargetGuardError("Refusing to read the SOURCE — its session is not read-only. Nothing was read or written.");
}

// ───────────────────────────── Timezone-safe sessions ─────────────────────────────

/**
 * Date/time types (and their arrays) are kept as the server's text: node-pg would otherwise parse
 * `date` and `timestamp` as LOCAL-time JS Dates, and JSON then writes them in UTC — on a machine in
 * IST (+05:30) a `date` 2026-04-01 would be restored as 2026-03-31. Text round-trips exactly.
 */
export const TEXT_DATE_TIME_OIDS: ReadonlySet<number> = new Set([
  1082, 1083, 1114, 1184, 1186, 1266, // date, time, timestamp, timestamptz, interval, timetz
  1182, 1183, 1115, 1185, 1187, 1270, // their array types
]);

type TypeParser = (value: string) => unknown;
export interface TypeParserSource {
  getTypeParser(oid: number, format?: "text" | "binary"): TypeParser;
}

/** node-pg `types` option for drill sessions: date/time values as text, everything else unchanged. */
export function textDateTimeTypes(base: TypeParserSource): TypeParserSource {
  return {
    getTypeParser: (oid, format) => (TEXT_DATE_TIME_OIDS.has(oid) && format !== "binary" ? (v: string) => v : base.getTypeParser(oid, format)),
  };
}

/** Session settings for both drill connections: UTC + ISO output, so text values and checksums are stable. */
export function drillSessionOptions(readOnly: boolean): string {
  return ["-c TimeZone=UTC", "-c DateStyle=ISO,YMD", ...(readOnly ? ["-c default_transaction_read_only=on"] : [])].join(" ");
}

/** Refuses rows holding JS Dates: they mean a session parsed date/time values in the local timezone. */
export function assertNoJsDates(table: string, rows: unknown[]): void {
  for (const row of rows) {
    for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
      if (value instanceof Date) throw new DrillError(`Refusing: "${table}"."${column}" was read as a JS Date — drill sessions must read date/time values as text (timezone-safe). Nothing was written.`);
    }
  }
}

/** JSON for the backup and the restore parameter: BigInt as text, values otherwise unchanged. */
export const toDrillJson = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

// ───────────────────────────── Output location ─────────────────────────────

export function isWithin(parent: string, child: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Backup files: absolute, `.scbak` extension, outside the project and the private file store. */
export function validateOutPath(out: string, projectDir: string, storageDir: string | undefined): string {
  if (!isAbsolute(out)) throw new DrillError("--out must be an absolute path.");
  const p = resolve(out);
  if (!p.toLowerCase().endsWith(".scbak")) throw new DrillError("--out must end with .scbak (encrypted SchoolERP backup).");
  if (isWithin(projectDir, p)) throw new DrillError("--out must be outside the project folder (backups contain personal data).");
  if (storageDir && isWithin(storageDir, p)) throw new DrillError("--out must be outside PRIVATE_STORAGE_LOCAL_DIR.");
  return p;
}

// ───────────────────────────── Encrypted backup format ─────────────────────────────

const MAGIC = "SCHOOLERP-BACKUP-1";
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
export const MIN_PASSPHRASE = 12;

interface Header {
  magic: typeof MAGIC;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  /** SHA-256 of the plaintext JSON (integrity check after decryption). */
  sha256: string;
  takenAt: string;
}

/**
 * File = one JSON header line + "\n" + AES-256-GCM ciphertext + 16-byte auth tag. The header is
 * authenticated as additional data, so tampering with it is detected too.
 */
export function encryptBackup(plaintext: Buffer, passphrase: string, takenAt: string, random: (n: number) => Buffer = randomBytes): Buffer {
  if (passphrase.length < MIN_PASSPHRASE) throw new DrillError(`Backup passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  const salt = random(16);
  const iv = random(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const header: Header = { magic: MAGIC, kdf: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64"), iv: iv.toString("base64"), sha256: createHash("sha256").update(plaintext).digest("hex"), takenAt };
  const headerLine = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(headerLine);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([headerLine, body, cipher.getAuthTag()]);
}

/** Throws DrillError on a wrong passphrase, a tampered file or a checksum mismatch. */
export function decryptBackup(file: Buffer, passphrase: string): { plaintext: Buffer; takenAt: string } {
  const nl = file.indexOf(0x0a);
  if (nl < 0) throw new DrillError("Not a SchoolERP backup file.");
  const headerLine = file.subarray(0, nl + 1);
  let h: Header;
  try {
    h = JSON.parse(headerLine.toString("utf8")) as Header;
  } catch {
    throw new DrillError("Not a SchoolERP backup file.");
  }
  if (h.magic !== MAGIC || h.kdf !== "scrypt") throw new DrillError("Unsupported backup file format.");
  if (file.length < nl + 1 + 16) throw new DrillError("Backup file is truncated.");
  const tag = file.subarray(file.length - 16);
  const body = file.subarray(nl + 1, file.length - 16);
  const key = scryptSync(passphrase, Buffer.from(h.salt, "base64"), 32, { N: h.N, r: h.r, p: h.p, maxmem: SCRYPT.maxmem });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(h.iv, "base64"));
  decipher.setAAD(headerLine);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DrillError("Backup could not be decrypted — wrong passphrase or the file was modified.");
  }
  const sha = createHash("sha256").update(plaintext).digest();
  if (!timingSafeEqual(sha, Buffer.from(h.sha256, "hex"))) throw new DrillError("Backup checksum mismatch.");
  return { plaintext, takenAt: h.takenAt };
}
