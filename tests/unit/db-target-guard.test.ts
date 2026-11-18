import { describe, expect, it } from "vitest";
import {
  assertLiveIdentity,
  assertShellClean,
  endpointOfUrl,
  resolveSeedTarget,
  SHELL_OVERRIDE_VARS,
  TargetGuardError,
} from "@/lib/db-target-guard";

/**
 * R1 (ADR-032): the seed's fail-closed target guard. Synthetic, in-memory values only; hosts use
 * the reserved `.invalid` TLD.
 */
const DEV = { branch: "br-dev-bbbb2222", ep: "ep-dev-bbbb2222" };
const TEST = { branch: "br-test-cccc3333", ep: "ep-test-cccc3333" };
const PROD = { branch: "br-prod-aaaa1111", ep: "ep-prodn-aaaa1111" };
const OTHER = { branch: "br-other-dddd4444", ep: "ep-other-dddd4444" };
const SECRET = "SYNTHETIC-PASSWORD-MARKER";
const url = (ep: string, pooled = true) => `postgresql://neondb_owner:${SECRET}@${ep}${pooled ? "-pooler" : ""}.region.invalid/neondb?sslmode=verify-full`;

const env = (over: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: url(DEV.ep),
  TEST_DATABASE_URL: url(TEST.ep),
  SEED_TARGET_BRANCH_ID: DEV.branch,
  SEED_TARGET_ENDPOINT_ID: DEV.ep,
  FORBIDDEN_BRANCH_IDS: PROD.branch,
  FORBIDDEN_ENDPOINT_IDS: PROD.ep,
  ...over,
});

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TargetGuardError);
    const m = (e as Error).message;
    expect(m).not.toContain(SECRET); // never a password …
    expect(m).not.toContain("region.invalid"); // … or a host/URL
    return m;
  }
  throw new Error("expected a refusal");
};

describe("step 1 — the shell must not redirect the run", () => {
  it.each(SHELL_OVERRIDE_VARS)("refuses when %s is set in the shell", (name) => {
    expect(refusal(() => assertShellClean({ [name]: name.endsWith("URL") ? url(DEV.ep) : ".env.test" }))).toContain(name);
  });
  it("accepts a clean shell (empty values count as unset)", () => {
    expect(() => assertShellClean({ PATH: "/usr/bin", DOTENV_PATH: "" })).not.toThrow();
  });
});

describe("steps 2–3 — configuration and URL host (no connection)", () => {
  it("accepts the allow-listed development target", () => {
    expect(resolveSeedTarget(env())).toEqual({ branchId: DEV.branch, endpointId: DEV.ep, forbiddenBranchIds: [PROD.branch], forbiddenEndpointIds: [PROD.ep] });
  });
  it.each<[string, Record<string, string | undefined>, RegExp]>([
    ["missing branch allow-list", { SEED_TARGET_BRANCH_ID: undefined }, /SEED_TARGET_BRANCH_ID is not set/],
    ["missing endpoint allow-list", { SEED_TARGET_ENDPOINT_ID: "" }, /SEED_TARGET_ENDPOINT_ID is not set/],
    ["malformed branch id", { SEED_TARGET_BRANCH_ID: "development" }, /not a Neon branch id/],
    ["malformed endpoint id", { SEED_TARGET_ENDPOINT_ID: "br-dev-bbbb2222" }, /not a Neon endpoint id/],
    ["no forbidden branches", { FORBIDDEN_BRANCH_IDS: undefined }, /FORBIDDEN_BRANCH_IDS is not set/],
    ["no forbidden endpoints", { FORBIDDEN_ENDPOINT_IDS: " , " }, /FORBIDDEN_ENDPOINT_IDS is not set/],
    ["malformed forbidden value", { FORBIDDEN_ENDPOINT_IDS: "production" }, /not an endpoint id/],
    ["allow-listed branch is forbidden", { FORBIDDEN_BRANCH_IDS: `${PROD.branch},${DEV.branch}` }, /SEED_TARGET_BRANCH_ID is listed in FORBIDDEN_BRANCH_IDS/],
    ["allow-listed endpoint is forbidden", { FORBIDDEN_ENDPOINT_IDS: DEV.ep }, /SEED_TARGET_ENDPOINT_ID is listed in FORBIDDEN_ENDPOINT_IDS/],
    ["DATABASE_URL is production", { DATABASE_URL: url(PROD.ep) }, /FORBIDDEN endpoint/],
    ["DATABASE_URL is production (direct form)", { DATABASE_URL: url(PROD.ep, false) }, /FORBIDDEN endpoint/],
    ["DATABASE_URL is the test endpoint", { DATABASE_URL: url(TEST.ep), SEED_TARGET_ENDPOINT_ID: DEV.ep }, /does not point to SEED_TARGET_ENDPOINT_ID|TEST endpoint/],
    ["allow-list points at the test endpoint", { DATABASE_URL: url(TEST.ep), SEED_TARGET_ENDPOINT_ID: TEST.ep }, /TEST endpoint/],
    ["DATABASE_URL is an unknown endpoint", { DATABASE_URL: url(OTHER.ep) }, /unknown or wrong endpoint/],
    ["DATABASE_URL missing", { DATABASE_URL: undefined }, /DATABASE_URL is not set/],
    ["DATABASE_URL garbage", { DATABASE_URL: "not a url" }, /not a valid URL/],
  ])("refuses: %s", (_label, over, msg) => {
    const m = refusal(() => resolveSeedTarget(env(over)));
    expect(m).toMatch(msg);
    expect(m).toContain("Nothing was written");
  });
  it("endpoint id comes from the host alone (pooled and direct forms)", () => {
    expect(endpointOfUrl(new URL(url(DEV.ep, true)))).toBe(DEV.ep);
    expect(endpointOfUrl(new URL(url(DEV.ep, false)))).toBe(DEV.ep);
  });
});

describe("step 4 — the server's own identity", () => {
  const target = () => resolveSeedTarget(env());
  it("accepts exactly the allow-listed branch and endpoint", () => {
    expect(() => assertLiveIdentity({ branch: DEV.branch, endpoint: DEV.ep }, target())).not.toThrow();
  });
  it.each<[string, { branch: string | null; endpoint: string | null } | null, RegExp]>([
    ["production branch", { branch: PROD.branch, endpoint: DEV.ep }, /FORBIDDEN/],
    ["production endpoint", { branch: DEV.branch, endpoint: PROD.ep }, /FORBIDDEN/],
    ["test branch", { branch: TEST.branch, endpoint: TEST.ep }, /not SEED_TARGET/],
    ["unknown branch", { branch: OTHER.branch, endpoint: DEV.ep }, /not SEED_TARGET/],
    ["unknown endpoint", { branch: DEV.branch, endpoint: OTHER.ep }, /not SEED_TARGET/],
    ["not Neon (no identity)", { branch: null, endpoint: null }, /can't be confirmed/],
    ["partial identity", { branch: DEV.branch, endpoint: null }, /can't be confirmed/],
    ["no row at all", null, /can't be confirmed/],
  ])("refuses: %s", (_l, id, msg) => {
    expect(refusal(() => assertLiveIdentity(id, target()))).toMatch(msg);
  });
});
