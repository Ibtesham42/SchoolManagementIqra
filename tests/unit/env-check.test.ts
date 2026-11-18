import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { endpointOfUrl, forbiddenEndpointHits, runEnvCheck, type BranchIdentity, type EnvCheckDeps } from "../../scripts/env-check-lib";

/**
 * `npm run env:check` production protection. Everything is synthetic and in memory: hosts use the
 * reserved `.invalid` TLD, `identity()` (the only network access) is a recording fake, and the
 * `.env` / `.env.test` "files" are strings. This test never loads dotenv or the real env files.
 */
const DEV = { branch: "br-dev-bbbb2222", ep: "ep-dev-bbbb2222" };
const TEST = { branch: "br-test-cccc3333", ep: "ep-test-cccc3333" };
const PROD = { branch: "br-prod-aaaa1111", ep: "ep-prodx-aaaa1111" };
const SECRET = "SYNTHETIC-PASSWORD-MARKER";
const url = (ep: string, pooled: boolean) => `postgresql://neondb_owner:${SECRET}@${ep}${pooled ? "-pooler" : ""}.region.invalid/neondb?sslmode=verify-full&channel_binding=require`;
const key = () => randomBytes(32).toString("base64");

function baseEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: url(DEV.ep, true),
    DIRECT_URL: url(DEV.ep, false),
    TEST_DATABASE_URL: url(TEST.ep, true),
    APP_URL: "http://localhost:3000",
    SESSION_SECRET: key(),
    DATA_ENCRYPTION_KEY: key(),
    DATA_HMAC_KEY: key(),
    DOCUMENT_VERIFICATION_KEY: key(),
    DOCUMENT_VERIFICATION_KEY_VERSION: "1",
    PRIVATE_STORAGE_LOCAL_DIR: "/data/erp-files",
    SEED_SUPERADMIN_USERNAME: "principal",
    SEED_SUPERADMIN_PASSWORD: "Long-enough-pass-9",
    FORBIDDEN_BRANCH_IDS: PROD.branch,
    FORBIDDEN_ENDPOINT_IDS: PROD.ep,
    ...over,
  };
}

const envTestFile = (pooled = url(TEST.ep, true), direct = url(TEST.ep, false)) => `DATABASE_URL=${pooled}\nDIRECT_URL=${direct}\n`;

function deps(opts: { envTest?: string | null; identities?: Partial<Record<string, BranchIdentity>> } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const files: Record<string, string> = { ".env": "(present)" };
  if (opts.envTest !== null) files[".env.test"] = opts.envTest ?? envTestFile();
  const name = (p: string) => p.replace(/\\/g, "/").split("/").pop()!;
  const defaults: Record<string, BranchIdentity> = {
    DATABASE_URL: { branch: DEV.branch, endpoint: DEV.ep, version: "18.6" },
    DIRECT_URL: { branch: DEV.branch, endpoint: DEV.ep, version: "18.6" },
    TEST_DATABASE_URL: { branch: TEST.branch, endpoint: TEST.ep, version: "18.6" },
  };
  const d: EnvCheckDeps = {
    identity: async (n) => {
      calls.push(n);
      return { ...defaults[n], ...(opts.identities?.[n] ?? {}) };
    },
    exists: (p) => name(p) in files,
    readFile: (p) => files[name(p)] ?? "",
    log: (l) => void logs.push(l),
    cwd: "/work/SchoolMang",
  };
  return { d, calls, logs, text: () => logs.join("\n") };
}

describe("endpoint id from host", () => {
  it("strips -pooler and the domain; needs no connection", () => {
    expect(endpointOfUrl(new URL(url(DEV.ep, true)))).toBe(DEV.ep);
    expect(endpointOfUrl(new URL(url(DEV.ep, false)))).toBe(DEV.ep);
  });
  it("forbiddenEndpointHits finds pooled and direct forms alike", () => {
    const urls: [string, URL][] = [["A", new URL(url(PROD.ep, true))], ["B", new URL(url(PROD.ep, false))], ["C", new URL(url(DEV.ep, true))]];
    expect(forbiddenEndpointHits(urls, [PROD.ep])).toEqual(["A", "B"]);
    expect(forbiddenEndpointHits(urls, [])).toEqual([]);
  });
});

describe("env:check connected mode", () => {
  it("passes for development + test, opening exactly the three read-only identity sessions", async () => {
    const t = deps();
    expect(await runEnvCheck(baseEnv(), t.d, false)).toBe(true);
    expect(t.calls.sort()).toEqual(["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL"]);
    expect(t.text()).toContain("no URL uses one of the 1 forbidden endpoint id(s)");
    expect(t.text()).toContain("ENV CHECK PASSED");
  });

  it.each([
    ["DATABASE_URL", { DATABASE_URL: url(PROD.ep, true) }, undefined],
    ["DIRECT_URL", { DIRECT_URL: url(PROD.ep, false) }, undefined],
    ["TEST_DATABASE_URL", { TEST_DATABASE_URL: url(PROD.ep, true) }, undefined],
    [".env.test DATABASE_URL", {}, envTestFile(url(PROD.ep, true))],
    [".env.test DIRECT_URL", {}, envTestFile(url(TEST.ep, true), url(PROD.ep, false))],
  ])("refuses a forbidden endpoint in %s BEFORE any connection attempt", async (name, over, envTest) => {
    const t = deps({ envTest });
    expect(await runEnvCheck(baseEnv(over), t.d, false)).toBe(false);
    expect(t.calls).toEqual([]); // identity() — the only network access — was never called
    expect(t.text()).toContain(`${name} points to an endpoint in FORBIDDEN_ENDPOINT_IDS (e.g. production) — refusing to connect`);
    expect(t.text()).toContain("no connection was attempted");
  });

  it("deliberate-failure drill: forbidding the development endpoint refuses without connecting", async () => {
    const t = deps();
    expect(await runEnvCheck(baseEnv({ FORBIDDEN_ENDPOINT_IDS: DEV.ep }), t.d, false)).toBe(false);
    expect(t.calls).toEqual([]);
    expect(t.text()).toMatch(/DATABASE_URL points to an endpoint in FORBIDDEN_ENDPOINT_IDS/);
    expect(t.text()).toMatch(/DIRECT_URL points to an endpoint in FORBIDDEN_ENDPOINT_IDS/);
  });

  it("requires FORBIDDEN_ENDPOINT_IDS — no connection without it", async () => {
    for (const value of [undefined, "", " , "]) {
      const t = deps();
      expect(await runEnvCheck(baseEnv({ FORBIDDEN_ENDPOINT_IDS: value }), t.d, false)).toBe(false);
      expect(t.calls).toEqual([]);
      expect(t.text()).toContain("FORBIDDEN_ENDPOINT_IDS is not set");
    }
  });

  it("still requires FORBIDDEN_BRANCH_IDS — no connection without it", async () => {
    const t = deps();
    expect(await runEnvCheck(baseEnv({ FORBIDDEN_BRANCH_IDS: undefined }), t.d, false)).toBe(false);
    expect(t.calls).toEqual([]);
    expect(t.text()).toContain("FORBIDDEN_BRANCH_IDS is not set");
  });

  it("rejects malformed protection ids without connecting", async () => {
    for (const over of [{ FORBIDDEN_ENDPOINT_IDS: "production" }, { FORBIDDEN_ENDPOINT_IDS: "br-prod-aaaa1111" }, { FORBIDDEN_BRANCH_IDS: "ep-prodx-aaaa1111" }]) {
      const t = deps();
      expect(await runEnvCheck(baseEnv(over), t.d, false)).toBe(false);
      expect(t.calls).toEqual([]);
    }
  });

  it("never connects when any earlier check failed (e.g. missing seed account)", async () => {
    const t = deps();
    expect(await runEnvCheck(baseEnv({ SEED_SUPERADMIN_PASSWORD: undefined }), t.d, false)).toBe(false);
    expect(t.calls).toEqual([]);
  });

  it("keeps the FORBIDDEN_BRANCH_IDS protection (branch identified after the read-only session)", async () => {
    const t = deps();
    expect(await runEnvCheck(baseEnv({ FORBIDDEN_BRANCH_IDS: DEV.branch }), t.d, false)).toBe(false);
    expect(t.text()).toContain("development branch is in FORBIDDEN_BRANCH_IDS (e.g. production) — refusing");
    expect(t.text()).toContain("ENV CHECK FAILED — do not migrate or seed");
  });

  it("defence in depth: refuses if the server's endpoint differs from the host or is forbidden", async () => {
    const mismatch = deps({ identities: { DATABASE_URL: { branch: DEV.branch, endpoint: TEST.ep, version: "18.6" } } });
    expect(await runEnvCheck(baseEnv(), mismatch.d, false)).toBe(false);
    expect(mismatch.text()).toContain("server reports a different endpoint than its host name");
  });

  it("prints no secret: no password, no connection string", async () => {
    for (const [over, envTest] of [[{}, undefined], [{ DATABASE_URL: url(PROD.ep, true) }, undefined]] as const) {
      const t = deps({ envTest });
      await runEnvCheck(baseEnv(over), t.d, false);
      expect(t.text()).not.toContain(SECRET);
      expect(t.text()).not.toMatch(/postgres(ql)?:\/\//);
      expect(t.text()).not.toContain("region.invalid");
    }
  });
});

describe("env:check offline mode", () => {
  it("never connects, and reports forbidden endpoints too", async () => {
    const good = deps();
    expect(await runEnvCheck(baseEnv(), good.d, true)).toBe(true);
    expect(good.calls).toEqual([]);
    expect(good.text()).toContain("FORBIDDEN_ENDPOINT_IDS: 1 id(s)");

    const hit = deps();
    expect(await runEnvCheck(baseEnv({ TEST_DATABASE_URL: url(PROD.ep, true) }), hit.d, true)).toBe(false);
    expect(hit.calls).toEqual([]);
    expect(hit.text()).toContain("TEST_DATABASE_URL points to an endpoint in FORBIDDEN_ENDPOINT_IDS");
  });
  it("does not require the protection ids offline (it only reports them)", async () => {
    const t = deps();
    expect(await runEnvCheck(baseEnv({ FORBIDDEN_ENDPOINT_IDS: undefined, FORBIDDEN_BRANCH_IDS: undefined }), t.d, true)).toBe(true);
    expect(t.text()).toContain("FORBIDDEN_BRANCH_IDS: 0 id(s); FORBIDDEN_ENDPOINT_IDS: 0 id(s)");
  });
});

describe("env:check — seed allow-list (SEED_TARGET_*, ADR-032)", () => {
  const seed = { SEED_TARGET_BRANCH_ID: DEV.branch, SEED_TARGET_ENDPOINT_ID: DEV.ep };
  it("offline: accepts the development branch/endpoint", async () => {
    const t = deps();
    expect(await runEnvCheck(baseEnv(seed), t.d, true)).toBe(true);
    expect(t.text()).toContain("SEED_TARGET_ENDPOINT_ID matches DATABASE_URL (development) and is not forbidden");
  });
  it("offline: only reports when not configured (db:seed will refuse)", async () => {
    const t = deps();
    expect(await runEnvCheck(baseEnv(), t.d, true)).toBe(true);
    expect(t.text()).toContain("required by npm run db:seed");
  });
  it.each<[string, Record<string, string>, RegExp]>([
    ["the test endpoint", { SEED_TARGET_BRANCH_ID: TEST.branch, SEED_TARGET_ENDPOINT_ID: TEST.ep }, /TEST endpoint/],
    ["a forbidden endpoint", { SEED_TARGET_BRANCH_ID: DEV.branch, SEED_TARGET_ENDPOINT_ID: PROD.ep }, /FORBIDDEN/],
    ["a forbidden branch", { SEED_TARGET_BRANCH_ID: PROD.branch, SEED_TARGET_ENDPOINT_ID: DEV.ep }, /FORBIDDEN/],
    ["an endpoint other than DATABASE_URL's", { SEED_TARGET_BRANCH_ID: DEV.branch, SEED_TARGET_ENDPOINT_ID: "ep-other-dddd4444" }, /does not match DATABASE_URL/],
    ["a malformed id", { SEED_TARGET_BRANCH_ID: "development", SEED_TARGET_ENDPOINT_ID: DEV.ep }, /not a Neon branch id/],
    ["only one of the two", { SEED_TARGET_BRANCH_ID: DEV.branch } as Record<string, string>, /SEED_TARGET_ENDPOINT_ID is missing/],
  ])("offline: rejects %s", async (_l, over, msg) => {
    const t = deps();
    expect(await runEnvCheck(baseEnv(over), t.d, true)).toBe(false);
    expect(t.text()).toMatch(msg);
  });
  it("connected: confirms the server's development branch is SEED_TARGET_BRANCH_ID", async () => {
    const t = deps();
    expect(await runEnvCheck(baseEnv(seed), t.d, false)).toBe(true);
    expect(t.text()).toContain("development branch is SEED_TARGET_BRANCH_ID");
  });
  it("connected: a mismatching branch fails (the seed would refuse)", async () => {
    const t = deps({ identities: { DATABASE_URL: { branch: "br-other-dddd4444", endpoint: DEV.ep, version: "18.6" }, DIRECT_URL: { branch: "br-other-dddd4444", endpoint: DEV.ep, version: "18.6" } } });
    expect(await runEnvCheck(baseEnv(seed), t.d, false)).toBe(false);
    expect(t.text()).toContain("development branch is NOT SEED_TARGET_BRANCH_ID");
  });
});
