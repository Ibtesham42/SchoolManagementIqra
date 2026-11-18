import { mkdir, readdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomToken } from "@/lib/crypto";

/**
 * Storage provider abstraction (ADR-018). Drivers store opaque bytes under opaque keys; encryption
 * and authorization happen above this layer (modules/files), so every provider only ever sees
 * ciphertext for private files. Add an S3-compatible driver by implementing this interface.
 */
export interface StorageDriver {
  readonly name: "local" | "memory" | "s3";
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * S-15 orphan reconciliation (KI-067): every PRIVATE key with its last-modified time, at most `limit` entries
   * (oldest folders first). Only names matching the strict key pattern are returned — temp files and anything
   * else in the folder are ignored, never reported as keys.
   */
  listPrivate(limit: number): Promise<{ key: string; modifiedAt: Date }[]>;
}

/** Upper bound for one reconciliation listing (a school's private files fit comfortably). */
export const LIST_PRIVATE_MAX = 100_000;

const KEY_PATTERN = /^(public|private)\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{16,64}$/;

/** Random key, never derived from the user's file name: "<visibility>/<yyyy>/<mm>/<random>". */
export function newStorageKey(visibility: "PUBLIC" | "PRIVATE", now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${visibility.toLowerCase()}/${yyyy}/${mm}/${randomToken(24)}`;
}

export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key");
}

/** Files on local disk under a root directory outside the web root. */
/** True if `child` is `parent` or inside it (case-insensitive on Windows). */
function isWithin(parent: string, child: string): boolean {
  const norm = (p: string) => (sep === "\\" ? p.toLowerCase() : p);
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class LocalDriver implements StorageDriver {
  readonly name = "local" as const;
  private readonly root: string;

  constructor(root: string, appDir = process.cwd()) {
    if (!root || !isAbsolute(root)) throw new Error("PRIVATE_STORAGE_LOCAL_DIR must be an absolute path");
    this.root = resolve(root);
    // Next.js serves <app>/public (and the build output) directly, bypassing authorization, audit and
    // soft delete. Refuse a storage root there, or one that contains them.
    for (const served of [resolve(appDir, "public"), resolve(appDir, ".next")]) {
      if (isWithin(served, this.root) || isWithin(this.root, served)) {
        throw new Error("PRIVATE_STORAGE_LOCAL_DIR must be outside the app's public/ and .next/ folders");
      }
    }
  }

  /** Resolve a key inside the root; refuses anything that would escape it (path traversal). */
  pathFor(key: string): string {
    assertValidKey(key);
    const full = resolve(join(this.root, ...key.split("/")));
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error("Storage key escapes root");
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    // Keys are random per upload; an existing key means a bug — never silently replace stored data.
    if (await this.exists(key)) throw new Error("Storage key already exists");
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomToken(6)}.tmp`; // write-then-rename: no partially written files
    await writeFile(tmp, bytes, { flag: "wx" });
    await rename(tmp, path);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.pathFor(key)).then(
      () => true,
      () => false,
    );
  }

  async listPrivate(limit: number): Promise<{ key: string; modifiedAt: Date }[]> {
    if (limit <= 0) return [];
    const out: { key: string; modifiedAt: Date }[] = [];
    const base = join(this.root, "private");
    const names = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    for (const y of await names(base)) {
      if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
      for (const m of await names(join(base, y.name))) {
        if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
        for (const f of await names(join(base, y.name, m.name))) {
          if (out.length >= limit) return out;
          const key = `private/${y.name}/${m.name}/${f.name}`;
          if (!f.isFile() || !KEY_PATTERN.test(key)) continue;
          out.push({ key, modifiedAt: (await stat(this.pathFor(key))).mtime });
        }
      }
    }
    return out;
  }
}

/** In-memory driver for tests. */
export class MemoryDriver implements StorageDriver {
  readonly name = "memory" as const;
  readonly blobs = new Map<string, Buffer>();
  /** Last-modified times (tests may backdate an entry to simulate an old blob). */
  readonly modified = new Map<string, Date>();
  async put(key: string, bytes: Uint8Array) {
    assertValidKey(key);
    if (this.blobs.has(key)) throw new Error("Storage key already exists");
    this.blobs.set(key, Buffer.from(bytes));
    this.modified.set(key, new Date());
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error("Not found");
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
    this.modified.delete(key);
  }
  async exists(key: string) {
    return this.blobs.has(key);
  }
  async listPrivate(limit: number) {
    return [...this.blobs.keys()]
      .filter((k) => k.startsWith("private/"))
      .sort()
      .slice(0, limit)
      .map((key) => ({ key, modifiedAt: this.modified.get(key) ?? new Date() }));
  }
}

let cached: StorageDriver | undefined;

/** Driver chosen by PRIVATE_STORAGE_DRIVER. S3-compatible storage is designed for but not implemented yet. */
export function getStorageDriver(): StorageDriver {
  if (cached) return cached;
  const driver = process.env.PRIVATE_STORAGE_DRIVER ?? "local";
  if (driver === "local") {
    const dir = process.env.PRIVATE_STORAGE_LOCAL_DIR;
    if (!dir) throw new Error("PRIVATE_STORAGE_LOCAL_DIR is not set (absolute path outside the project's public/ folder)");
    cached = new LocalDriver(dir);
    return cached;
  }
  throw new Error(`Storage driver "${driver}" is not implemented yet (see docs/KNOWN_ISSUES.md)`);
}

/** Tests only. */
export function setStorageDriverForTests(driver: StorageDriver | undefined): void {
  cached = driver;
}
