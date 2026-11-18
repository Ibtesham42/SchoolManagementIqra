import { parse as parseDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { passwordProblem } from "@/lib/auth/password";
import { USERNAME_PATTERN } from "@/modules/identity/identity.schemas";
import {
  assertSafeCliArgs,
  assertUrlsReplaceable,
  formatEnvValue,
  generateMissingKeys,
  mergeEnv,
  parseArgs,
  readEnvValues,
  resolveBranchLayout,
  resolveStorageDir,
  sanitize,
  SetupError,
  validateConnectionString,
  validateSeed,
  type NeonBranch,
  type NeonEndpoint,
} from "../../scripts/setup-env-lib";
import { runSetup, type SetupIO } from "../../scripts/setup-env";

/**
 * `npm run setup:env` security requirements. All values are synthetic and in memory: hosts use the
 * reserved `.invalid` TLD (they can never resolve), passwords are obvious markers. No file is
 * touched — the I/O layer is a recording fake.
 */
const PROJECT = "demo-project-11111111";
const PROD = { id: "br-prod-aaaa1111", ep: "ep-prod-aaaa1111" };
const DEV = { id: "br-dev-bbbb2222", ep: "ep-dev-bbbb2222" };
const TEST = { id: "br-test-cccc3333", ep: "ep-test-cccc3333" };
const SECRET = "SYNTHETIC-PASSWORD-MARKER";

const branches = (): NeonBranch[] => [
  { id: PROD.id, name: "production", default: true, parent_id: null },
  { id: DEV.id, name: "development", parent_id: PROD.id },
  { id: TEST.id, name: "test", parent_id: PROD.id },
];
const endpoints = (): NeonEndpoint[] => [
  { id: PROD.ep, branch_id: PROD.id, type: "read_write", host: `${PROD.ep}.region.invalid` },
  { id: DEV.ep, branch_id: DEV.id, type: "read_write", host: `${DEV.ep}.region.invalid` },
  { id: TEST.ep, branch_id: TEST.id, type: "read_write", host: `${TEST.ep}.region.invalid` },
];
const url = (ep: string, pooled: boolean, pw = SECRET) =>
  `postgresql://neondb_owner:${pw}@${ep}${pooled ? "-pooler" : ""}.region.invalid/neondb?sslmode=require&channel_binding=require`;
const layout = () => resolveBranchLayout(branches(), endpoints());

// ───────────────────────────── Arguments & CLI safety ─────────────────────────────

describe("arguments", () => {
  it("requires a well-formed project id and rejects unknown options", () => {
    expect(parseArgs(["--project-id", PROJECT])).toEqual({ projectId: PROJECT, dryRun: false, replaceUrls: false, seedOnly: false });
    expect(parseArgs([`--project-id=${PROJECT}`, "--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["--seed-only"])).toMatchObject({ seedOnly: true, projectId: "" });
    expect(() => parseArgs(["--seed-only", "--project-id", PROJECT])).toThrow(/don't combine/);
    expect(() => parseArgs(["--seed-only", "--replace-urls"])).toThrow(/don't combine/);
    expect(() => parseArgs([])).toThrow(SetupError);
    expect(() => parseArgs(["--project-id", "x; rm -rf /"])).toThrow(SetupError);
    expect(() => parseArgs(["--project-id", PROJECT, "--force"])).toThrow(/Unknown option/);
  });
  it("only inert arguments ever reach the neonctl shell", () => {
    expect(() => assertSafeCliArgs(["branches", "list", "--project-id", PROJECT, `/projects/${PROJECT}/endpoints`])).not.toThrow();
    for (const bad of ["a b", "x;y", "x&y", "x|y", "$(id)", "`id`", "x>y", '"q"', "x\ny", "%PATH%"]) {
      expect(() => assertSafeCliArgs(["connection-string", bad]), bad).toThrow(SetupError);
    }
  });
});

// ───────────────────────────── Branch layout ─────────────────────────────

describe("branch layout", () => {
  it("identifies production (default), development and test with their endpoints", () => {
    const l = layout();
    expect(l.production.id).toBe(PROD.id);
    expect(l.development).toMatchObject({ id: DEV.id, endpointId: DEV.ep });
    expect(l.test).toMatchObject({ id: TEST.id, endpointId: TEST.ep });
    expect(l.productionEndpointIds).toEqual([PROD.ep]);
  });
  it.each<[string, () => [NeonBranch[], NeonEndpoint[]]]>([
    ["no default branch", () => [branches().map((b) => ({ ...b, default: false })), endpoints()]],
    ["two default branches", () => [branches().map((b) => ({ ...b, default: b.name !== "test" })), endpoints()]],
    ["missing development", () => [branches().filter((b) => b.name !== "development"), endpoints()]],
    ["duplicate test name", () => [[...branches(), { id: "br-x-dddd4444", name: "test", parent_id: PROD.id }], endpoints()]],
    ["development is the default branch", () => [branches().map((b) => (b.name === "development" ? { ...b, default: true } : { ...b, default: false })), endpoints()]],
    ["development not a child of production", () => [branches().map((b) => (b.name === "development" ? { ...b, parent_id: TEST.id } : b)), endpoints()]],
    ["development and test are the same branch", () => [branches().map((b) => (b.name === "test" ? { ...b, id: DEV.id } : b)), endpoints()]],
    ["no read-write endpoint on test", () => [branches(), endpoints().filter((e) => e.branch_id !== TEST.id)]],
    ["two read-write endpoints on development", () => [branches(), [...endpoints(), { id: "ep-dev-eeee5555", branch_id: DEV.id, type: "read_write", host: "ep-dev-eeee5555.region.invalid" }]]],
    ["endpoint host not matching its id", () => [branches(), endpoints().map((e) => (e.branch_id === DEV.id ? { ...e, host: "ep-other-1.region.invalid" } : e))]],
  ])("refuses: %s", (_label, input) => {
    const [b, e] = input();
    expect(() => resolveBranchLayout(b, e)).toThrow(SetupError);
  });
});

// ───────────────────────────── Connection strings ─────────────────────────────

describe("connection string validation", () => {
  const prodEps = [PROD.ep];
  it("accepts the right endpoint, enforces verify-full and keeps channel_binding", () => {
    const out = validateConnectionString(url(DEV.ep, true), { endpointId: DEV.ep, pooled: true, label: "development pooled" }, prodEps);
    const u = new URL(out);
    expect(u.searchParams.get("sslmode")).toBe("verify-full");
    expect(u.searchParams.get("channel_binding")).toBe("require");
    expect(u.hostname.startsWith(`${DEV.ep}-pooler.`)).toBe(true);
    expect(validateConnectionString(url(TEST.ep, false), { endpointId: TEST.ep, pooled: false, label: "test direct" }, prodEps)).toContain(`@${TEST.ep}.`);
  });
  it.each([
    ["a production endpoint", url(PROD.ep, true), DEV.ep, true, /PRODUCTION/],
    ["the other branch's endpoint", url(TEST.ep, true), DEV.ep, true, /different endpoint/],
    ["direct where pooled is required", url(DEV.ep, false), DEV.ep, true, /pooled/],
    ["pooled where direct is required", url(DEV.ep, true), DEV.ep, false, /direct/],
    ["no password", `postgresql://neondb_owner@${DEV.ep}-pooler.region.invalid/neondb`, DEV.ep, true, /credentials/],
    ["not PostgreSQL", `https://${DEV.ep}-pooler.region.invalid/`, DEV.ep, true, /PostgreSQL/],
    ["garbage", "not a url", DEV.ep, true, /valid connection string/],
  ])("refuses %s — and the error reveals nothing of the string", (_l, raw, ep, pooled, msg) => {
    let message = "";
    try {
      validateConnectionString(raw, { endpointId: ep, pooled, label: "development pooled" }, prodEps);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(msg);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("region.invalid");
    expect(message).not.toContain("neondb_owner");
  });
  it("sanitize() masks URLs, credentials and Neon password tokens", () => {
    const s = sanitize(`failed ${url(DEV.ep, true)} password=hunter2 token: abc npg_AbC123xyz`);
    expect(s).not.toContain(SECRET);
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("npg_AbC123xyz");
    expect(s).toContain("<masked-url>");
  });
});

// ───────────────────────────── .env merge, keys, storage, seed ─────────────────────────────

describe(".env merging", () => {
  const template = "# comment\nDATABASE_URL=\nDB_POOL_MAX=5\n\nSESSION_SECRET=\n# tail\n";
  it("updates in place, preserves comments and other lines, appends missing keys", () => {
    const out = mergeEnv(template, { DATABASE_URL: "A", SESSION_SECRET: "B", NEW_KEY: "C" });
    expect(out).toBe("# comment\nDATABASE_URL=A\nDB_POOL_MAX=5\n\nSESSION_SECRET=B\n# tail\nNEW_KEY=C\n");
  });
  it("removes later duplicates so a stale value can't win", () => {
    expect(mergeEnv("DATABASE_URL=old\nX=1\nDATABASE_URL=older\n", { DATABASE_URL: "new" })).toBe("DATABASE_URL=new\nX=1\n");
  });
  it("keeps CRLF line endings", () => {
    expect(mergeEnv("A=1\r\nB=2\r\n", { B: "3" })).toBe("A=1\r\nB=3\r\n");
  });
  it("reads values like dotenv (first wins, quotes stripped)", () => {
    const v = readEnvValues('A="x"\nA=y\nB=\n# C=z\n');
    expect(v.get("A")).toBe("x");
    expect(v.get("B")).toBe("");
    expect(v.has("C")).toBe(false);
  });
  it("refuses to replace configured database strings without --replace-urls", () => {
    const filled = readEnvValues("DATABASE_URL=something\nDIRECT_URL=\n");
    expect(() => assertUrlsReplaceable(filled, false, ".env", ["DATABASE_URL", "DIRECT_URL"])).toThrow(/--replace-urls/);
    expect(() => assertUrlsReplaceable(filled, true, ".env", ["DATABASE_URL", "DIRECT_URL"])).not.toThrow();
    expect(() => assertUrlsReplaceable(readEnvValues("DATABASE_URL=\n"), false, ".env", ["DATABASE_URL"])).not.toThrow();
  });
});

describe("key generation", () => {
  it("fills every empty slot with a distinct 32-byte key", () => {
    const keys = generateMissingKeys(new Map());
    expect(Object.keys(keys).sort()).toEqual(["DATA_ENCRYPTION_KEY", "DATA_HMAC_KEY", "DOCUMENT_VERIFICATION_KEY", "SESSION_SECRET"]);
    const values = Object.values(keys);
    expect(new Set(values).size).toBe(4);
    for (const v of values) expect(Buffer.from(v, "base64").length).toBe(32);
  });
  it("never overwrites an existing key and never duplicates one", () => {
    const existing = Buffer.alloc(32, 1).toString("base64");
    const keys = generateMissingKeys(new Map([["DATA_ENCRYPTION_KEY", existing]]));
    expect(keys).not.toHaveProperty("DATA_ENCRYPTION_KEY");
    expect(Object.values(keys)).not.toContain(existing);
    // A random source that first repeats the existing key is retried.
    let n = 0;
    const repeating = (size: number) => (n++ === 0 ? Buffer.alloc(size, 1) : Buffer.alloc(size, n));
    expect(Object.values(generateMissingKeys(new Map([["DATA_ENCRYPTION_KEY", existing]]), repeating))).not.toContain(existing);
  });
  it("refuses when existing keys are already duplicated", () => {
    const same = Buffer.alloc(32, 2).toString("base64");
    expect(() => generateMissingKeys(new Map([["DATA_HMAC_KEY", same], ["SESSION_SECRET", same]]))).toThrow(SetupError);
  });
});

describe("private storage location", () => {
  const project = "/work/SchoolMang";
  it("defaults to <home>/SchoolERP-files and keeps a configured folder", () => {
    expect(resolveStorageDir("", "/home/owner", project).replace(/\\/g, "/")).toMatch(/\/home\/owner\/SchoolERP-files$/);
    expect(resolveStorageDir("/data/erp-files", "/home/owner", project).replace(/\\/g, "/")).toMatch(/\/data\/erp-files$/);
  });
  it("refuses relative paths, folders inside the project, and folders containing it", () => {
    expect(() => resolveStorageDir("files", "/home/owner", project)).toThrow(/absolute/);
    expect(() => resolveStorageDir("/work/SchoolMang/public/uploads", "/home/owner", project)).toThrow(/outside/);
    expect(() => resolveStorageDir("/work", "/home/owner", project)).toThrow(/outside/);
  });
});

describe("seed account", () => {
  const rules = { usernamePattern: USERNAME_PATTERN, passwordProblem };
  it("uses the same rules as the app and the seed", () => {
    expect(() => validateSeed("principal", "Long-enough-pass-9", rules)).not.toThrow();
    expect(() => validateSeed("Principal", "Long-enough-pass-9", rules)).toThrow(SetupError);
    expect(() => validateSeed("principal", "short", rules)).toThrow(/at least 10/);
    expect(() => validateSeed("principal", "myprincipal123", rules)).toThrow(/username/);
    expect(() => validateSeed("principal", "password123", rules)).toThrow(/common/);
  });
});

// ───────────────────────────── End-to-end with a recording fake ─────────────────────────────

interface Recorder {
  io: SetupIO;
  neonCalls: string[][];
  reads: string[];
  writes: Map<string, string>;
  logs: string[];
  existsCalls: string[];
  prompts: number;
}

function fake(opts: { interactive?: boolean; files?: Record<string, string>; urls?: Partial<Record<string, string>>; answers?: string[] } = {}): Recorder {
  const r: Recorder = { neonCalls: [], reads: [], writes: new Map(), logs: [], existsCalls: [], prompts: 0, io: undefined as unknown as SetupIO };
  const files = { ...(opts.files ?? {}) };
  const answers = [...(opts.answers ?? [])];
  const cwd = "/work/SchoolMang";
  const key = (p: string) => p.replace(/\\/g, "/").split("/").pop()!;
  r.io = {
    neon(args) {
      r.neonCalls.push(args);
      if (args[0] === "branches") return JSON.stringify(branches());
      if (args[0] === "api") return JSON.stringify({ endpoints: endpoints() });
      if (args[0] === "connection-string") {
        const which = args[1] === DEV.id ? "dev" : "test";
        const pooled = args.includes("--pooled");
        const k = `${which}-${pooled ? "pooled" : "direct"}`;
        return `${opts.urls?.[k] ?? url(which === "dev" ? DEV.ep : TEST.ep, pooled)}\n`;
      }
      throw new Error("unexpected neon call");
    },
    exists: (p) => (r.existsCalls.push(key(p)), key(p) in files),
    readFile: (p) => (r.reads.push(key(p)), files[key(p)] ?? ""),
    writeFileAtomic: (p, t) => void r.writes.set(key(p), t),
    mkdirp: () => undefined,
    isInteractive: () => opts.interactive ?? false,
    prompt: async () => (r.prompts++, answers.shift() ?? ""),
    promptHidden: async () => (r.prompts++, answers.shift() ?? ""),
    log: (l) => void r.logs.push(l),
    runOfflineCheck: () => 0,
    home: "/home/owner",
    cwd,
    passwordProblem,
    usernamePattern: USERNAME_PATTERN,
  };
  return r;
}

const TEMPLATE = "# template\nFORBIDDEN_BRANCH_IDS=\nDATABASE_URL=\nDIRECT_URL=\nTEST_DATABASE_URL=\nAPP_URL=http://localhost:3000\nSESSION_SECRET=\nDATA_ENCRYPTION_KEY=\nDATA_HMAC_KEY=\nDOCUMENT_VERIFICATION_KEY=\nPRIVATE_STORAGE_LOCAL_DIR=\nSEED_SUPERADMIN_USERNAME=\nSEED_SUPERADMIN_PASSWORD=\n";

describe("runSetup --dry-run (the only mode an agent may run)", () => {
  it("never opens .env/.env.test, never requests a connection string, writes nothing, needs no terminal", async () => {
    const r = fake({ interactive: false, files: { ".env": TEMPLATE, ".env.test": "" } });
    expect(await runSetup(["--project-id", PROJECT, "--dry-run"], r.io)).toBe(0);
    expect(r.reads).toEqual([]);
    expect(r.existsCalls).toEqual([]);
    expect(r.writes.size).toBe(0);
    expect(r.prompts).toBe(0);
    expect(r.neonCalls.map((c) => c[0])).toEqual(["branches", "api"]);
    expect(r.logs.join("\n")).not.toMatch(/postgres(ql)?:\/\/|SYNTHETIC/);
  });
});

describe("runSetup (owner run)", () => {
  it("refuses without an interactive terminal — before reading files or requesting strings", async () => {
    const r = fake({ interactive: false, files: { ".env": TEMPLATE } });
    await expect(runSetup(["--project-id", PROJECT], r.io)).rejects.toThrow(/interactive terminal/);
    expect(r.reads).toEqual([]);
    expect(r.writes.size).toBe(0);
    expect(r.neonCalls.some((c) => c[0] === "connection-string")).toBe(false);
  });

  it("writes both files correctly and logs no secret", async () => {
    const r = fake({ interactive: true, files: { ".env": TEMPLATE }, answers: ["principal", "Long-enough-pass-9", "Long-enough-pass-9"] });
    expect(await runSetup(["--project-id", PROJECT], r.io)).toBe(0);
    const env = readEnvValues(r.writes.get(".env")!);
    expect(new URL(env.get("DATABASE_URL")!).hostname.startsWith(`${DEV.ep}-pooler.`)).toBe(true);
    expect(new URL(env.get("DIRECT_URL")!).hostname.startsWith(`${DEV.ep}.`)).toBe(true);
    expect(new URL(env.get("TEST_DATABASE_URL")!).hostname.startsWith(`${TEST.ep}-pooler.`)).toBe(true);
    for (const k of ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL"]) expect(new URL(env.get(k)!).searchParams.get("sslmode")).toBe("verify-full");
    expect(env.get("FORBIDDEN_BRANCH_IDS")).toBe(PROD.id);
    expect(env.get("FORBIDDEN_ENDPOINT_IDS")).toBe(PROD.ep);
    expect(env.get("SEED_TARGET_BRANCH_ID")).toBe(DEV.id);
    expect(env.get("SEED_TARGET_ENDPOINT_ID")).toBe(DEV.ep);
    expect(env.get("APP_URL")).toBe("http://localhost:3000"); // untouched template line
    expect(new Set(["SESSION_SECRET", "DATA_ENCRYPTION_KEY", "DATA_HMAC_KEY", "DOCUMENT_VERIFICATION_KEY"].map((k) => env.get(k))).size).toBe(4);
    expect(env.get("PRIVATE_STORAGE_LOCAL_DIR")!.replace(/\\/g, "/")).toMatch(/SchoolERP-files$/);
    expect(env.get("SEED_SUPERADMIN_USERNAME")).toBe("principal");

    const test = readEnvValues(r.writes.get(".env.test")!);
    expect([...test.keys()].sort()).toEqual(["DATABASE_URL", "DIRECT_URL"]);
    expect(new URL(test.get("DATABASE_URL")!).hostname.startsWith(`${TEST.ep}-pooler.`)).toBe(true);
    expect(new URL(test.get("DIRECT_URL")!).hostname.startsWith(`${TEST.ep}.`)).toBe(true);

    const log = r.logs.join("\n");
    expect(log).not.toContain(SECRET);
    expect(log).not.toMatch(/postgres(ql)?:\/\//);
    expect(log).not.toContain("Long-enough-pass-9");
    for (const k of ["SESSION_SECRET", "DATA_ENCRYPTION_KEY"]) expect(log).not.toContain(env.get(k)!);
    // production is never asked for a connection string
    expect(r.neonCalls.filter((c) => c[0] === "connection-string").map((c) => c[1]).sort()).toEqual([DEV.id, DEV.id, TEST.id, TEST.id]);
  });

  it("refuses — and writes nothing — when neonctl hands back a production endpoint", async () => {
    const r = fake({ interactive: true, files: { ".env": TEMPLATE }, urls: { "dev-pooled": url(PROD.ep, true) } });
    await expect(runSetup(["--project-id", PROJECT], r.io)).rejects.toThrow(/PRODUCTION/);
    expect(r.writes.size).toBe(0);
  });

  it("refuses to overwrite configured database strings — before requesting new ones", async () => {
    const configured = TEMPLATE.replace("DATABASE_URL=\n", "DATABASE_URL=already-set\n");
    const r = fake({ interactive: true, files: { ".env": configured } });
    await expect(runSetup(["--project-id", PROJECT], r.io)).rejects.toThrow(/--replace-urls/);
    expect(r.neonCalls.some((c) => c[0] === "connection-string")).toBe(false);
    expect(r.writes.size).toBe(0);
  });

  it("keeps existing keys and storage folder; only empty slots are filled", async () => {
    const k1 = Buffer.alloc(32, 7).toString("base64");
    const withKey = TEMPLATE.replace("DATA_ENCRYPTION_KEY=\n", `DATA_ENCRYPTION_KEY=${k1}\n`).replace("PRIVATE_STORAGE_LOCAL_DIR=\n", "PRIVATE_STORAGE_LOCAL_DIR=/data/erp-files\n");
    const r = fake({ interactive: true, files: { ".env": withKey }, answers: [""] });
    await runSetup(["--project-id", PROJECT], r.io);
    const env = readEnvValues(r.writes.get(".env")!);
    expect(env.get("DATA_ENCRYPTION_KEY")).toBe(k1);
    expect(env.get("PRIVATE_STORAGE_LOCAL_DIR")!.replace(/\\/g, "/")).toMatch(/\/data\/erp-files$/);
    expect(env.get("SEED_SUPERADMIN_USERNAME")).toBe(""); // skipped
  });

  it("mismatched passwords abort with nothing written", async () => {
    const r = fake({ interactive: true, files: { ".env": TEMPLATE }, answers: ["principal", "Long-enough-pass-9", "Different-pass-99"] });
    await expect(runSetup(["--project-id", PROJECT], r.io)).rejects.toThrow(/did not match/);
    expect(r.writes.size).toBe(0);
  });
});

// ───────────────────────────── Regression: values dotenv would truncate ─────────────────────────────

describe("values are written so dotenv reads them back exactly (seed password truncation bug)", () => {
  const tricky = [
    "Strong#Pass2026",
    "Long pass #2026x",
    " lead-space-2026",
    "trail-space-2026 ",
    "Pa$$word-2026x",
    "a=b=c-2026xx",
    "back\\slash-2026",
    'dq"inside-2026',
    "sq'inside-2026",
    "both'and\"q-2026",
    "plain-Value_2026",
  ];
  it.each(tricky)("round-trips %j", (v) => {
    const text = mergeEnv("A=1\nSEED_SUPERADMIN_PASSWORD=\nB=2\n", { SEED_SUPERADMIN_PASSWORD: v });
    const parsed = parseDotenv(text);
    expect(parsed.SEED_SUPERADMIN_PASSWORD).toBe(v);
    expect(parsed.A).toBe("1");
    expect(parsed.B).toBe("2");
  });
  it("leaves plain values (URLs, base64 keys) unquoted and quotes Windows paths safely", () => {
    expect(formatEnvValue(url(DEV.ep, true))).toBe(url(DEV.ep, true));
    expect(formatEnvValue(Buffer.alloc(32, 9).toString("base64"))).not.toMatch(/^['"`]/);
    const winPath = "C:\\Users\\owner\\SchoolERP-files";
    expect(parseDotenv(`P=${formatEnvValue(winPath)}\n`).P).toBe(winPath);
  });
  it("refuses line breaks, control characters and values containing every quote kind", () => {
    expect(() => formatEnvValue("line\nbreak-2026")).toThrow(SetupError);
    expect(() => formatEnvValue("tab\there-2026")).toThrow(SetupError);
    expect(() => formatEnvValue("all'\"`quotes\\x")).toThrow(SetupError);
  });
  it("full setup stores a password containing # so the seed reads all of it", async () => {
    const pw = "Strong#Pass2026";
    const r = fake({ interactive: true, files: { ".env": TEMPLATE }, answers: ["principal", pw, pw] });
    await runSetup(["--project-id", PROJECT], r.io);
    expect(parseDotenv(r.writes.get(".env")!).SEED_SUPERADMIN_PASSWORD).toBe(pw);
    expect(r.logs.join("\n")).not.toContain(pw);
  });
});

describe("runSetup --seed-only", () => {
  const configured = mergeEnv(TEMPLATE, {
    DATABASE_URL: url(DEV.ep, true),
    DIRECT_URL: url(DEV.ep, false),
    TEST_DATABASE_URL: url(TEST.ep, true),
    SESSION_SECRET: Buffer.alloc(32, 1).toString("base64"),
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    DATA_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
    DOCUMENT_VERIFICATION_KEY: Buffer.alloc(32, 4).toString("base64"),
    FORBIDDEN_BRANCH_IDS: PROD.id,
    PRIVATE_STORAGE_LOCAL_DIR: "/data/erp-files",
    SEED_SUPERADMIN_USERNAME: "principal",
    SEED_SUPERADMIN_PASSWORD: "Strong", // what dotenv read back from the earlier unquoted "Strong#…"
  });
  const pw = "Strong#Pass2026";

  it("changes only the two seed lines, makes no Neon call, never touches .env.test, logs no secret", async () => {
    const r = fake({ interactive: true, files: { ".env": configured, ".env.test": "DATABASE_URL=x\nDIRECT_URL=y\n" }, answers: ["principal", pw, pw] });
    expect(await runSetup(["--seed-only"], r.io)).toBe(0);
    expect(r.neonCalls).toEqual([]);
    expect(r.reads).toEqual([".env"]);
    expect([...r.writes.keys()]).toEqual([".env"]);
    const before = parseDotenv(configured);
    const after = parseDotenv(r.writes.get(".env")!);
    for (const k of Object.keys(before)) if (!k.startsWith("SEED_")) expect(after[k], k).toBe(before[k]);
    expect(after.SEED_SUPERADMIN_PASSWORD).toBe(pw);
    expect(after.SEED_SUPERADMIN_USERNAME).toBe("principal");
    const log = r.logs.join("\n");
    expect(log).not.toContain(pw);
    expect(log).not.toMatch(/postgres(ql)?:\/\//);
  });
  it("enforces the app's password rules and leaves .env untouched on any problem", async () => {
    const cases = [
      ["principal", "short", "short"],
      ["principal", "password123", "password123"],
      ["principal", "myprincipal-2026", "myprincipal-2026"],
      ["principal", pw, "different-2026x"],
    ];
    for (const answers of cases) {
      const r = fake({ interactive: true, files: { ".env": configured }, answers });
      await expect(runSetup(["--seed-only"], r.io)).rejects.toThrow(SetupError);
      expect(r.writes.size).toBe(0);
    }
  });
  it("skipping changes nothing; no terminal or no .env refuses", async () => {
    const skip = fake({ interactive: true, files: { ".env": configured }, answers: [""] });
    expect(await runSetup(["--seed-only"], skip.io)).toBe(0);
    expect(skip.writes.size).toBe(0);
    await expect(runSetup(["--seed-only"], fake({ interactive: false, files: { ".env": configured } }).io)).rejects.toThrow(/interactive terminal/);
    await expect(runSetup(["--seed-only"], fake({ interactive: true, files: {} }).io)).rejects.toThrow(/\.env not found/);
  });
});
