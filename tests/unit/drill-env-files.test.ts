import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptBuffer, encryptBuffer } from "@/lib/crypto";
import { TargetGuardError } from "@/lib/db-target-guard";
import { passwordProblem } from "@/lib/auth/password";
import { USERNAME_PATTERN } from "@/modules/identity/identity.schemas";
import { resolveDrillTarget, readEnvValues, SetupError, type NeonBranch, type NeonEndpoint } from "../../scripts/setup-env-lib";
import { RESTORE_ENV_FILE, runDrillEnv } from "../../scripts/drill-env";
import type { SetupIO } from "../../scripts/setup-env";
import { FilesBackupError, MANIFEST_FORMAT, runFilesBackup, runFilesVerify, validateDest, type FilesDeps, type Manifest, type ManifestEntry } from "../../scripts/files-backup-core";
import type { DrillClient } from "../../scripts/backup-drill-core";

/** ADR-033 drill credentials + file-store backup (G6-0). Synthetic and in memory only. */
const PROJECT = "demo-project-11111111";
const PROD = { id: "br-prod-aaaa1111", ep: "ep-prodn-aaaa1111" };
const DEV = { id: "br-dev-bbbb2222", ep: "ep-dev-bbbb2222" };
const TEST = { id: "br-test-cccc3333", ep: "ep-test-cccc3333" };
const DRILL = { id: "br-drill-dddd4444", ep: "ep-drill-dddd4444" };
const SECRET = "SYNTHETIC-PASSWORD-MARKER";
const url = (ep: string, pooled: boolean) => `postgresql://neondb_owner:${SECRET}@${ep}${pooled ? "-pooler" : ""}.region.invalid/neondb?sslmode=require`;

const branches = (extra: NeonBranch[] = [{ id: DRILL.id, name: "pitr-drill", parent_id: DEV.id }]): NeonBranch[] => [
  { id: PROD.id, name: "production", default: true, parent_id: null },
  { id: DEV.id, name: "development", parent_id: PROD.id },
  { id: TEST.id, name: "test", parent_id: PROD.id },
  ...extra,
];
const endpoints = (extra: NeonEndpoint[] = [{ id: DRILL.ep, branch_id: DRILL.id, type: "read_write", host: `${DRILL.ep}.region.invalid` }]): NeonEndpoint[] => [
  { id: PROD.ep, branch_id: PROD.id, type: "read_write", host: `${PROD.ep}.region.invalid` },
  { id: DEV.ep, branch_id: DEV.id, type: "read_write", host: `${DEV.ep}.region.invalid` },
  { id: TEST.ep, branch_id: TEST.id, type: "read_write", host: `${TEST.ep}.region.invalid` },
  ...extra,
];

// ───────────────────────────── drill:env ─────────────────────────────

describe("drill branch rules", () => {
  it("accepts a child of development with one read-write endpoint", () => {
    expect(resolveDrillTarget(branches(), endpoints(), "pitr-drill")).toMatchObject({ id: DRILL.id, endpointId: DRILL.ep });
  });
  it.each<[string, () => [NeonBranch[], NeonEndpoint[], string]]>([
    ["production by name", () => [branches(), endpoints(), "production"]],
    ["development", () => [branches(), endpoints(), "development"]],
    ["test", () => [branches(), endpoints(), "test"]],
    ["child of production (not development)", () => [branches([{ id: DRILL.id, name: "pitr-drill", parent_id: PROD.id }]), endpoints(), "pitr-drill"]],
    ["child of test", () => [branches([{ id: DRILL.id, name: "pitr-drill", parent_id: TEST.id }]), endpoints(), "pitr-drill"]],
    ["missing branch", () => [branches([]), endpoints([]), "pitr-drill"]],
    ["no read-write endpoint", () => [branches(), endpoints([]), "pitr-drill"]],
    ["endpoint host mismatch", () => [branches(), endpoints([{ id: DRILL.ep, branch_id: DRILL.id, type: "read_write", host: "ep-other.region.invalid" }]), "pitr-drill"]],
    ["bad name", () => [branches(), endpoints(), "Pitr Drill"]],
  ])("refuses %s", (_l, f) => {
    const [b, e, n] = f();
    expect(() => resolveDrillTarget(b, e, n)).toThrow(SetupError);
  });
});

function drillIo(opts: { interactive?: boolean; existing?: boolean; urls?: Partial<Record<"pooled" | "direct", string>> } = {}) {
  const calls: string[][] = [];
  const writes = new Map<string, string>();
  const logs: string[] = [];
  const io: SetupIO = {
    neon(args) {
      calls.push(args);
      if (args[0] === "branches") return JSON.stringify(branches());
      if (args[0] === "api") return JSON.stringify({ endpoints: endpoints() });
      if (args[0] === "connection-string") {
        const pooled = args.includes("--pooled");
        return `${opts.urls?.[pooled ? "pooled" : "direct"] ?? url(DRILL.ep, pooled)}\n`;
      }
      throw new Error("unexpected");
    },
    exists: () => !!opts.existing,
    readFile: () => "",
    writeFileAtomic: (p, t) => void writes.set(p.replace(/\\/g, "/").split("/").pop()!, t),
    mkdirp: () => undefined,
    isInteractive: () => opts.interactive ?? false,
    prompt: async () => "",
    promptHidden: async () => "",
    log: (l) => void logs.push(l),
    runOfflineCheck: () => 0,
    home: "/home/owner",
    cwd: "/work/SchoolMang",
    passwordProblem,
    usernamePattern: USERNAME_PATTERN,
  };
  return { io, calls, writes, logs };
}

describe("npm run drill:env", () => {
  const argv = ["--project-id", PROJECT, "--branch", "pitr-drill"];
  it("dry run: requests no connection string, writes nothing, needs no terminal", async () => {
    const r = drillIo();
    expect(await runDrillEnv([...argv, "--dry-run"], r.io)).toBe(0);
    expect(r.calls.map((c) => c[0])).toEqual(["branches", "api"]);
    expect(r.writes.size).toBe(0);
  });
  it("refuses without a terminal, and refuses to overwrite an existing file", async () => {
    await expect(runDrillEnv(argv, drillIo().io)).rejects.toThrow(/interactive terminal/);
    await expect(runDrillEnv(argv, drillIo({ interactive: true, existing: true }).io)).rejects.toThrow(/--replace/);
  });
  it("writes exactly the drill URLs and allow-list ids to .env.restore.local; logs no secret", async () => {
    const r = drillIo({ interactive: true });
    expect(await runDrillEnv(argv, r.io)).toBe(0);
    const env = readEnvValues(r.writes.get(RESTORE_ENV_FILE)!);
    expect([...env.keys()].sort()).toEqual(["DATABASE_URL", "DIRECT_URL", "DRILL_TARGET_BRANCH_ID", "DRILL_TARGET_ENDPOINT_ID"]);
    expect(env.get("DRILL_TARGET_BRANCH_ID")).toBe(DRILL.id);
    expect(new URL(env.get("DIRECT_URL")!).hostname.startsWith(`${DRILL.ep}.`)).toBe(true);
    expect(new URL(env.get("DATABASE_URL")!).hostname.startsWith(`${DRILL.ep}-pooler.`)).toBe(true);
    expect(new URL(env.get("DIRECT_URL")!).searchParams.get("sslmode")).toBe("verify-full");
    expect(r.logs.join("\n")).not.toMatch(/SYNTHETIC|postgres(ql)?:\/\//);
    expect(r.calls.filter((c) => c[0] === "connection-string").every((c) => c[1] === DRILL.id)).toBe(true);
  });
  it("refuses a connection string for another branch (e.g. production) — nothing written", async () => {
    const r = drillIo({ interactive: true, urls: { pooled: url(PROD.ep, true) } });
    await expect(runDrillEnv(argv, r.io)).rejects.toThrow(/PRODUCTION/);
    expect(r.writes.size).toBe(0);
  });
});

// ───────────────────────────── files:backup / files:verify ─────────────────────────────

const STORE = "/data/erp-files";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type FileRow = { storage_key: string; visibility: "PUBLIC" | "PRIVATE"; purpose: string; encrypted: boolean; key_version: number | null; sha256: string; size_bytes: number; deleted: boolean };

function filesWorld(opts: { identity?: { branch: string; endpoint: string }; readOnly?: string; tamper?: boolean; extraRows?: FileRow[]; extraBlobs?: Record<string, Buffer> } = {}) {
  const logo = Buffer.from("PNG-synthetic-logo");
  const doc = Buffer.from("%PDF-synthetic-private");
  const enc = encryptBuffer(doc);
  const fs = new Map<string, Buffer>();
  const p = (...parts: string[]) => [...parts].join("/").replace(/\\/g, "/");
  fs.set(p(STORE, "public/2026/11/logoAAAAAAAAAAAAAAAA"), logo);
  fs.set(p(STORE, "private/2026/11/docAAAAAAAAAAAAAAAAA"), enc.data);
  const rows = [
    { storage_key: "public/2026/11/logoAAAAAAAAAAAAAAAA", visibility: "PUBLIC", purpose: "school.logo", encrypted: false, key_version: null, sha256: sha(logo), size_bytes: logo.length, deleted: false },
    { storage_key: "private/2026/11/docAAAAAAAAAAAAAAAAA", visibility: "PRIVATE", purpose: "document.pdf", encrypted: true, key_version: enc.keyVersion, sha256: sha(doc), size_bytes: doc.length, deleted: false },
    ...(opts.extraRows ?? []),
  ];
  for (const [key, blob] of Object.entries(opts.extraBlobs ?? {})) fs.set(p(STORE, key), blob);
  const queries: string[] = [];
  const client: DrillClient = {
    async query<T>(sql: string) {
      queries.push(sql);
      if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: opts.readOnly ?? "on" }] as T[] };
      if (sql.includes("neon.branch_id")) return { rows: [opts.identity ?? { branch: DEV.id, endpoint: DEV.ep }] as T[] };
      if (sql.includes("FROM stored_file")) return { rows: rows as T[] };
      return { rows: [] as T[] };
    },
    async end() {},
  };
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  const logs: string[] = [];
  const deps: FilesDeps = {
    shellEnv: {},
    loadDevEnv: () => ({
      DATABASE_URL: url(DEV.ep, true),
      TEST_DATABASE_URL: url(TEST.ep, true),
      SEED_TARGET_BRANCH_ID: DEV.id,
      SEED_TARGET_ENDPOINT_ID: DEV.ep,
      FORBIDDEN_BRANCH_IDS: PROD.id,
      FORBIDDEN_ENDPOINT_IDS: PROD.ep,
      PRIVATE_STORAGE_LOCAL_DIR: STORE,
    }),
    connect: async () => client,
    exists: (x) => fs.has(norm(x)) || [...fs.keys()].some((k) => k.startsWith(`${norm(x)}/`)),
    isEmptyDir: (x) => ![...fs.keys()].some((k) => k.startsWith(`${norm(x)}/`)),
    readFile: (x) => fs.get(norm(x))!,
    writeFileExclusive: (x, d) => {
      if (fs.has(norm(x))) throw new Error("EEXIST");
      fs.set(norm(x), opts.tamper && norm(x).includes("/backup/private/") ? Buffer.from("tampered") : d);
    },
    mkdirp: () => undefined,
    decrypt: (b, v) => decryptBuffer(b, v),
    log: (l) => void logs.push(l),
    projectDir: "/work/SchoolMang",
  };
  return { deps, fs, logs, queries, norm };
}

describe("files:backup / files:verify", () => {
  it("destination guard: absolute, outside the project, separate from the store", () => {
    expect(() => validateDest("backup", "/work/SchoolMang", STORE)).toThrow(/absolute/);
    expect(() => validateDest("/work/SchoolMang/backup", "/work/SchoolMang", STORE)).toThrow(/outside the project/);
    expect(() => validateDest(`${STORE}/backup`, "/work/SchoolMang", STORE)).toThrow(/separate/);
    expect(() => validateDest("/data", "/work/SchoolMang", STORE)).toThrow(/separate/);
    expect(validateDest("/backups/files-1", "/work/SchoolMang", STORE).replace(/\\/g, "/")).toMatch(/\/backups\/files-1$/);
  });
  it("backup copies blobs as stored (private stays encrypted) and writes a manifest without file names", async () => {
    const w = filesWorld();
    expect(await runFilesBackup(["--dest", "/backup"], w.deps)).toBe(true);
    const manifest = JSON.parse(w.fs.get("/backup/manifest.json")!.toString()) as { entries: Record<string, unknown>[] };
    expect(manifest.entries).toHaveLength(2);
    for (const e of manifest.entries) expect(Object.keys(e)).not.toContain("originalName");
    expect(w.fs.get("/backup/private/2026/11/docAAAAAAAAAAAAAAAAA")!.includes(Buffer.from("%PDF"))).toBe(false);
    expect(w.logs.join("\n")).toMatch(/2 blob\(s\) copied \(1 private, encrypted as stored\)/);
    expect(w.queries.every((q) => !/^(INSERT|UPDATE|DELETE|BEGIN)/.test(q))).toBe(true);
  });
  it("verify passes for the backup and for the live store (private files decrypt and hash correctly)", async () => {
    const w = filesWorld();
    await runFilesBackup(["--dest", "/backup"], w.deps);
    expect(await runFilesVerify(["--dest", "/backup"], w.deps)).toBe(true);
    expect(await runFilesVerify([], w.deps)).toBe(true);
    expect(w.logs.join("\n")).toMatch(/2 blob\(s\) verified/);
  });
  it("verify detects a modified blob", async () => {
    const w = filesWorld({ tamper: true });
    await runFilesBackup(["--dest", "/backup"], w.deps);
    expect(await runFilesVerify(["--dest", "/backup"], w.deps)).toBe(false);
  });
  it("verify detects a key that can't decrypt the private files", async () => {
    const w = filesWorld();
    await runFilesBackup(["--dest", "/backup"], w.deps);
    const saved = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    try {
      expect(await runFilesVerify(["--dest", "/backup"], w.deps)).toBe(false);
      expect(w.logs.join("\n")).toMatch(/could not be decrypted with the configured keys/);
    } finally {
      process.env.DATA_ENCRYPTION_KEY = saved;
    }
  });
  it("refuses a non-empty destination and never overwrites", async () => {
    const w = filesWorld();
    await runFilesBackup(["--dest", "/backup"], w.deps);
    await expect(runFilesBackup(["--dest", "/backup"], w.deps)).rejects.toThrow(/new or empty folder/);
  });
  it("reads only after a read-only session on the development branch is confirmed", async () => {
    const notRo = filesWorld({ readOnly: "off" });
    await expect(runFilesVerify([], notRo.deps)).rejects.toThrow(/not read-only/);
    expect(notRo.queries.some((q) => q.includes("FROM stored_file"))).toBe(false);
    const wrong = filesWorld({ identity: { branch: PROD.id, endpoint: DEV.ep } });
    await expect(runFilesVerify([], wrong.deps)).rejects.toBeInstanceOf(TargetGuardError);
    expect(wrong.queries.some((q) => q.includes("FROM stored_file"))).toBe(false);
  });
  it("requires --dest for a backup", async () => {
    await expect(runFilesBackup([], filesWorld().deps)).rejects.toBeInstanceOf(FilesBackupError);
  });
});

describe("files:backup / files:verify — G6-D regressions", () => {
  const manifestOf = (w: ReturnType<typeof filesWorld>) => JSON.parse(w.fs.get("/backup/manifest.json")!.toString()) as Manifest;
  const KEY_VARS = ["DATA_ENCRYPTION_KEY", "DATA_ENCRYPTION_KEY_VERSION", "DATA_ENCRYPTION_KEY_V1"] as const;
  const withKeys = async (fn: () => Promise<void>) => {
    const saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
    try {
      await fn();
    } finally {
      for (const k of KEY_VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it("the manifest carries no plaintext content hash for PRIVATE files (public files keep theirs)", async () => {
    const w = filesWorld();
    expect(await runFilesBackup(["--dest", "/backup"], w.deps)).toBe(true);
    const m = manifestOf(w);
    expect(m.format).toBe(MANIFEST_FORMAT);
    const priv = m.entries.find((e) => e.visibility === "PRIVATE")!;
    const pub = m.entries.find((e) => e.visibility === "PUBLIC")!;
    expect(priv).not.toHaveProperty("contentSha256");
    expect(pub.contentSha256).toBe(sha(Buffer.from("PNG-synthetic-logo")));
    // The private file's plaintext hash appears nowhere in the manifest (only the ciphertext hash does).
    const plainHash = sha(Buffer.from("%PDF-synthetic-private"));
    expect(w.fs.get("/backup/manifest.json")!.toString()).not.toContain(plainHash);
    expect(priv.blobSha256).not.toBe(plainHash);
    // Integrity is still proven: verify decrypts and compares with stored_file.sha256.
    expect(await runFilesVerify(["--dest", "/backup"], w.deps)).toBe(true);
    expect(w.logs.join("\n")).toMatch(/2 blob\(s\) verified/);
  });

  it("a format-1 manifest (with private content hashes) is still verifiable", async () => {
    const w = filesWorld();
    await runFilesBackup(["--dest", "/backup"], w.deps);
    const m = manifestOf(w);
    w.fs.set("/backup/manifest.json", Buffer.from(JSON.stringify({ ...m, format: "schoolerp-files-1" })));
    expect(await runFilesVerify(["--dest", "/backup"], w.deps)).toBe(true);
    w.fs.set("/backup/manifest.json", Buffer.from(JSON.stringify({ ...m, format: "schoolerp-files-9" })));
    await expect(runFilesVerify(["--dest", "/backup"], w.deps)).rejects.toThrow(/Unsupported manifest format/);
  });

  it("decrypts files written under an older key version (DATA_ENCRYPTION_KEY_V<n>) after rotation", async () => {
    await withKeys(async () => {
      const oldKey = Buffer.alloc(32, 1).toString("base64");
      process.env.DATA_ENCRYPTION_KEY = oldKey;
      process.env.DATA_ENCRYPTION_KEY_VERSION = "1";
      const oldDoc = Buffer.from("%PDF-synthetic-old-version");
      const oldEnc = encryptBuffer(oldDoc);
      expect(oldEnc.keyVersion).toBe(1);
      // Rotate: new current key v2, old key kept as _V1.
      process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
      process.env.DATA_ENCRYPTION_KEY_VERSION = "2";
      process.env.DATA_ENCRYPTION_KEY_V1 = oldKey;
      const key = "private/2026/10/oldAAAAAAAAAAAAAAAAA";
      const w = filesWorld({
        extraRows: [{ storage_key: key, visibility: "PRIVATE", purpose: "document.pdf", encrypted: true, key_version: 1, sha256: sha(oldDoc), size_bytes: oldDoc.length, deleted: false }],
        extraBlobs: { [key]: oldEnc.data },
      });
      expect(await runFilesBackup(["--dest", "/backup"], w.deps)).toBe(true);
      expect(await runFilesVerify(["--dest", "/backup"], w.deps)).toBe(true);
      expect(await runFilesVerify([], w.deps)).toBe(true);
      expect(w.logs.join("\n")).toMatch(/3 blob\(s\) verified/);
      // Without the rotated-out key, the older file is reported (not silently skipped).
      delete process.env.DATA_ENCRYPTION_KEY_V1;
      expect(await runFilesVerify(["--dest", "/backup"], w.deps)).toBe(false);
      expect(w.logs.join("\n")).toMatch(/could not be decrypted with the configured keys/);
    });
  });

  it("a soft-deleted record whose blob is gone is not a problem; a live record's missing blob is", async () => {
    const gone = (deleted: boolean): FileRow => ({ storage_key: "private/2026/09/goneAAAAAAAAAAAAAAAA", visibility: "PRIVATE", purpose: "document.pdf", encrypted: true, key_version: 1, sha256: "0".repeat(64), size_bytes: 10, deleted });
    const soft = filesWorld({ extraRows: [gone(true)] });
    expect(await runFilesBackup(["--dest", "/backup"], soft.deps)).toBe(true);
    expect(manifestOf(soft).entries.map((e) => e.key)).not.toContain("private/2026/09/goneAAAAAAAAAAAAAAAA");
    expect(await runFilesVerify(["--dest", "/backup"], soft.deps)).toBe(true);
    expect(await runFilesVerify([], soft.deps)).toBe(true);

    const live = filesWorld({ extraRows: [gone(false)] });
    expect(await runFilesBackup(["--dest", "/backup"], live.deps)).toBe(false);
    expect(live.logs.join("\n")).toMatch(/1 live file row\(s\) have no blob in the store/);
    expect(await runFilesVerify([], live.deps)).toBe(false);
    expect(live.logs.join("\n")).toMatch(/a live file's blob is missing/);
  });

  it("an unexpected manifest entry (unknown to the database) fails verification", async () => {
    const w = filesWorld();
    await runFilesBackup(["--dest", "/backup"], w.deps);
    const m = manifestOf(w);
    const stray: ManifestEntry = { key: "private/2026/11/strayAAAAAAAAAAAAAAA", visibility: "PRIVATE", purpose: "document.pdf", encrypted: true, keyVersion: 1, blobSha256: "f".repeat(64), blobBytes: 1, deleted: false };
    w.fs.set("/backup/manifest.json", Buffer.from(JSON.stringify({ ...m, entries: [...m.entries, stray] })));
    expect(await runFilesVerify(["--dest", "/backup"], w.deps)).toBe(false);
    expect(w.logs.join("\n")).toMatch(/the manifest lists a blob the database does not know/);
    expect(w.logs.join("\n")).not.toContain("stray"); // counts and categories only, never keys
  });

  it("a blob in the backup that the manifest omits fails verification", async () => {
    const w = filesWorld();
    await runFilesBackup(["--dest", "/backup"], w.deps);
    const m = manifestOf(w);
    w.fs.set("/backup/manifest.json", Buffer.from(JSON.stringify({ ...m, entries: m.entries.filter((e) => e.visibility === "PUBLIC") })));
    expect(await runFilesVerify(["--dest", "/backup"], w.deps)).toBe(false);
    expect(w.logs.join("\n")).toMatch(/a blob is not listed in the manifest/);
  });
});
