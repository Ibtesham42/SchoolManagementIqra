/**
 * `npm run files:backup -- --dest <folder>` / `npm run files:verify [-- --dest <folder>]`
 * (ADR-033). Logic and safety rules: scripts/files-backup-core.ts. Read-only towards the database;
 * prints counts only — never file names, contents, keys or connection strings.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import pg from "pg";
import { decryptBuffer } from "../src/lib/crypto";
import type { DrillClient } from "./backup-drill-core";
import { runFilesBackup, runFilesVerify, type FilesDeps } from "./files-backup-core";

const shellEnv = { ...process.env };
const mode = process.argv[2];
const sanitize = (m: string) => m.replace(/postgres(ql)?:\/\/[^\s]+/g, "<url>").replace(/npg_[A-Za-z0-9]+/g, "***");

let devEnv: Record<string, string | undefined> | null = null;
const deps: FilesDeps = {
  shellEnv,
  loadDevEnv: () => {
    const p = resolve(process.cwd(), ".env");
    if (!existsSync(p)) throw new Error(".env not found in the project folder.");
    devEnv = parseDotenv(readFileSync(p));
    return devEnv;
  },
  connect: async (url) => {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30_000, options: "-c default_transaction_read_only=on" });
    await c.connect();
    return c as unknown as DrillClient;
  },
  exists: (p) => existsSync(p),
  isEmptyDir: (p) => statSync(p).isDirectory() && readdirSync(p).length === 0,
  readFile: (p) => readFileSync(p),
  writeFileExclusive: (p, d) => writeFileSync(p, d, { flag: "wx" }), // never overwrites
  mkdirp: (p) => void mkdirSync(p, { recursive: true }),
  decrypt: (blob, keyVersion) => {
    // lib/crypto reads its keys from process.env: expose only the encryption keys from .env.
    for (const [k, v] of Object.entries(devEnv ?? {})) if (/^DATA_ENCRYPTION_KEY(_VERSION|_V\d+)?$/.test(k) && v) process.env[k] = v;
    return decryptBuffer(blob, keyVersion); // reads the keys at call time
  },
  log: (l) => console.log(l),
  projectDir: process.cwd(),
};

const run = mode === "backup" ? runFilesBackup : mode === "verify" ? runFilesVerify : null;
if (!run) {
  console.error("usage: files-backup.ts <backup|verify> [--dest <absolute folder>]");
  process.exitCode = 1;
} else {
  run(process.argv.slice(3), deps)
    .then((ok) => {
      if (!ok) process.exitCode = 1;
    })
    .catch((e: unknown) => {
      console.error(`✗ ${sanitize(e instanceof Error ? e.message : String(e))}`);
      process.exitCode = 1;
    });
}
