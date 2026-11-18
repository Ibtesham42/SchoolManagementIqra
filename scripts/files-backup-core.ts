/**
 * Private/public file-store backup and verification (ADR-033):
 *
 *   npm run files:backup -- --dest <absolute folder>   copy every stored blob + manifest
 *   npm run files:verify -- --dest <absolute folder>   check a backup against the database
 *   npm run files:verify                               check the live store against the database
 *
 * - Reads `stored_file` from DEVELOPMENT in a READ-ONLY session after the live identity check
 *   (development allow-list SEED_TARGET_*, forbidden lists); never writes to any database.
 * - The destination must be absolute, empty/new, outside the project and outside the store.
 * - The manifest holds storage keys, sizes and blob hashes only — no original file names (they
 *   can contain personal names), nothing decrypted, and NO content hash for PRIVATE files (a
 *   plaintext SHA-256 would let a backup holder confirm a guessed document). PRIVATE content is
 *   checked against `stored_file.sha256` from the database after decryption instead.
 * - Verification: each blob's hash matches the manifest; PUBLIC blobs hash to the row's sha256;
 *   PRIVATE blobs decrypt (same DATA_ENCRYPTION_KEY versions) to content whose hash equals the
 *   row's sha256 — proving the backup is restorable with the configured keys. Counts only.
 * Unit-tested in tests/unit/drill-env-files.test.ts ("files:backup / files:verify").
 */
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { assertLiveIdentity, assertShellClean, IDENTITY_SQL, resolveSeedTarget, type DbIdentity } from "../src/lib/db-target-guard";
import { assertValidKey } from "../src/lib/storage/driver";
import type { DrillClient } from "./backup-drill-core";
import { assertReadOnly, isWithin } from "./drill-lib";

export class FilesBackupError extends Error {}

export interface StoredFileRow {
  storage_key: string;
  visibility: "PUBLIC" | "PRIVATE";
  purpose: string;
  encrypted: boolean;
  key_version: number | null;
  sha256: string;
  size_bytes: number;
  deleted: boolean;
}

export interface ManifestEntry {
  key: string;
  visibility: "PUBLIC" | "PRIVATE";
  purpose: string;
  encrypted: boolean;
  keyVersion: number | null;
  /** SHA-256 of the stored blob (ciphertext for PRIVATE files). */
  blobSha256: string;
  /** SHA-256 of the original content — PUBLIC files only (equals blobSha256); never for PRIVATE. */
  contentSha256?: string;
  blobBytes: number;
  deleted: boolean;
}

export const MANIFEST_FORMAT = "schoolerp-files-2";
/** Format 1 (G6-0) also carried private content hashes; it is still accepted for verification. */
const READABLE_FORMATS = new Set(["schoolerp-files-1", MANIFEST_FORMAT]);

export interface Manifest {
  format: typeof MANIFEST_FORMAT | "schoolerp-files-1";
  takenAt: string;
  entries: ManifestEntry[];
}

export interface FilesDeps {
  shellEnv: Record<string, string | undefined>;
  loadDevEnv(): Record<string, string | undefined>;
  connect(url: string, opts: { readOnly: true }): Promise<DrillClient>;
  exists(path: string): boolean;
  isEmptyDir(path: string): boolean;
  readFile(path: string): Buffer;
  writeFileExclusive(path: string, data: Buffer): void;
  mkdirp(path: string): void;
  /** Decrypts a PRIVATE blob with the configured key version (lib/crypto). */
  decrypt(blob: Buffer, keyVersion: number): Buffer;
  log(line: string): void;
  projectDir: string;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function parseFilesArgs(argv: string[]): { dest: string | null } {
  let dest: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dest") dest = argv[++i] ?? "";
    else throw new FilesBackupError(`Unknown option "${argv[i].slice(0, 40)}". Use [--dest <absolute folder>].`);
  }
  if (dest !== null && !dest.trim()) throw new FilesBackupError("--dest needs an absolute folder.");
  return { dest };
}

/** Destination: absolute; not inside the project, not inside the store, and the store not inside it. */
export function validateDest(dest: string, projectDir: string, storageDir: string): string {
  if (!isAbsolute(dest)) throw new FilesBackupError("--dest must be an absolute folder.");
  const d = resolve(dest);
  if (isWithin(projectDir, d) || isWithin(d, projectDir)) throw new FilesBackupError("--dest must be outside the project folder.");
  if (isWithin(storageDir, d) || isWithin(d, storageDir)) throw new FilesBackupError("--dest must be separate from PRIVATE_STORAGE_LOCAL_DIR.");
  return d;
}

/** Storage keys come from the database: re-validate before touching the file system. */
const blobPath = (root: string, key: string) => {
  assertValidKey(key);
  return join(root, ...key.split("/"));
};

async function readRows(deps: FilesDeps, env: Record<string, string | undefined>): Promise<StoredFileRow[]> {
  const target = resolveSeedTarget(env); // development allow-list, not forbidden, not test — no connection yet
  const c = await deps.connect(env.DATABASE_URL!, { readOnly: true });
  try {
    assertReadOnly((await c.query<{ transaction_read_only: string }>("SHOW transaction_read_only")).rows[0]?.transaction_read_only);
    assertLiveIdentity((await c.query<DbIdentity>(IDENTITY_SQL)).rows[0], target);
    const { rows } = await c.query<StoredFileRow>(
      `SELECT storage_key, visibility, purpose, encrypted, key_version, sha256, size_bytes, (deleted_at IS NOT NULL) AS deleted FROM stored_file ORDER BY storage_key`,
    );
    return rows;
  } finally {
    await c.end();
  }
}

function storageRoot(env: Record<string, string | undefined>): string {
  const dir = env.PRIVATE_STORAGE_LOCAL_DIR;
  if ((env.PRIVATE_STORAGE_DRIVER ?? "local") !== "local") throw new FilesBackupError("files:backup supports PRIVATE_STORAGE_DRIVER=local only.");
  if (!dir || !isAbsolute(dir)) throw new FilesBackupError("PRIVATE_STORAGE_LOCAL_DIR must be set to an absolute folder in .env.");
  return resolve(dir);
}

export async function runFilesBackup(argv: string[], deps: FilesDeps): Promise<boolean> {
  const { dest } = parseFilesArgs(argv);
  if (!dest) throw new FilesBackupError("files:backup needs --dest <absolute folder>.");
  assertShellClean(deps.shellEnv);
  const env = deps.loadDevEnv();
  const root = storageRoot(env);
  const out = validateDest(dest, deps.projectDir, root);
  if (deps.exists(out) && !deps.isEmptyDir(out)) throw new FilesBackupError("--dest must be a new or empty folder (a backup never overwrites).");
  const rows = await readRows(deps, env);

  const entries: ManifestEntry[] = [];
  let missingLive = 0;
  for (const r of rows) {
    const src = blobPath(root, r.storage_key);
    if (!deps.exists(src)) {
      if (!r.deleted) missingLive++;
      continue;
    }
    const blob = deps.readFile(src);
    const target = blobPath(out, r.storage_key);
    deps.mkdirp(resolve(target, ".."));
    deps.writeFileExclusive(target, blob);
    entries.push({
      key: r.storage_key,
      visibility: r.visibility,
      purpose: r.purpose,
      encrypted: r.encrypted,
      keyVersion: r.key_version,
      blobSha256: sha(blob),
      ...(r.visibility === "PUBLIC" && !r.encrypted ? { contentSha256: r.sha256 } : {}),
      blobBytes: blob.length,
      deleted: r.deleted,
    });
  }
  const manifest: Manifest = { format: MANIFEST_FORMAT, takenAt: new Date().toISOString(), entries };
  deps.mkdirp(out);
  deps.writeFileExclusive(join(out, "manifest.json"), Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  deps.log(`files:backup: ${rows.length} stored_file row(s); ${entries.length} blob(s) copied (${entries.filter((e) => e.visibility === "PRIVATE").length} private, encrypted as stored); manifest written`);
  if (missingLive) deps.log(`✗ ${missingLive} live file row(s) have no blob in the store`);
  return missingLive === 0;
}

export async function runFilesVerify(argv: string[], deps: FilesDeps): Promise<boolean> {
  const { dest } = parseFilesArgs(argv);
  assertShellClean(deps.shellEnv);
  const env = deps.loadDevEnv();
  const root = storageRoot(env);
  const location = dest ? validateDest(dest, deps.projectDir, root) : root;
  const rows = await readRows(deps, env);

  let manifest: Manifest | null = null;
  if (dest) {
    const mpath = join(location, "manifest.json");
    if (!deps.exists(mpath)) throw new FilesBackupError("manifest.json not found in --dest.");
    manifest = JSON.parse(deps.readFile(mpath).toString("utf8")) as Manifest;
    if (!READABLE_FORMATS.has(manifest.format)) throw new FilesBackupError("Unsupported manifest format.");
  }
  const byKey = new Map((manifest?.entries ?? []).map((e) => [e.key, e]));
  let ok = 0;
  const problems: string[] = [];
  for (const r of rows) {
    const p = blobPath(location, r.storage_key);
    if (!deps.exists(p)) {
      if (!r.deleted) problems.push("a live file's blob is missing");
      continue;
    }
    const blob = deps.readFile(p);
    if (manifest) {
      const e = byKey.get(r.storage_key);
      if (!e) problems.push("a blob is not listed in the manifest");
      else if (e.blobSha256 !== sha(blob) || e.blobBytes !== blob.length) problems.push("a blob does not match its manifest hash");
    }
    let content: Buffer;
    try {
      content = r.encrypted ? deps.decrypt(blob, r.key_version ?? 1) : blob;
    } catch {
      problems.push("a PRIVATE blob could not be decrypted with the configured keys");
      continue;
    }
    if (sha(content) !== r.sha256) problems.push(`a ${r.visibility} file's content hash does not match the database`);
    else ok++;
  }
  if (manifest) for (const e of manifest.entries) if (!rows.some((r) => r.storage_key === e.key)) problems.push("the manifest lists a blob the database does not know");
  deps.log(`files:verify (${dest ? "backup" : "live store"}): ${rows.length} row(s), ${ok} blob(s) verified (private decrypted + hashed), ${problems.length} problem(s)`);
  for (const p of [...new Set(problems)]) deps.log(`✗ ${p}`);
  return problems.length === 0;
}
