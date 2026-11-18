import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `.env.example` is the template owners copy to `.env`. Once the owner fills in only the documented
 * lines (NEON_SETUP_GUIDE Step 4), the app's start-up validation must pass — an empty line left in
 * the template must never make the app refuse to start. Stand-in values are generated in memory;
 * the URL points to an invalid test host and is never connected to.
 */
const template = Object.fromEntries(
  readFileSync(new URL("../../.env.example", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const key = () => randomBytes(32).toString("base64");
const ownerFills = () => ({
  DATABASE_URL: "postgresql://u:p@db.invalid.example.test/x",
  DIRECT_URL: "postgresql://u:p@db.invalid.example.test/x",
  SESSION_SECRET: key(),
  DATA_ENCRYPTION_KEY: key(),
  DATA_HMAC_KEY: key(),
  DOCUMENT_VERIFICATION_KEY: key(),
});

afterEach(() => vi.unstubAllEnvs());

describe(".env.example", () => {
  it("passes start-up validation once the documented values are filled in", async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries({ ...template, ...ownerFills() })) vi.stubEnv(k, v);
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).not.toThrow();
  });
  it("an empty required line is still reported as missing (empty never counts as configured)", async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries({ ...template, ...ownerFills(), DOCUMENT_VERIFICATION_KEY: "" })) vi.stubEnv(k, v);
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).toThrow(/DOCUMENT_VERIFICATION_KEY/);
  });
  it("contains no values for secrets or connection strings", () => {
    for (const name of ["FORBIDDEN_BRANCH_IDS", "FORBIDDEN_ENDPOINT_IDS", "SEED_TARGET_BRANCH_ID", "SEED_TARGET_ENDPOINT_ID", "DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", "SESSION_SECRET", "DATA_ENCRYPTION_KEY", "DATA_HMAC_KEY", "DOCUMENT_VERIFICATION_KEY", "CRON_SECRET", "SEED_SUPERADMIN_PASSWORD"]) {
      expect(template[name], name).toBe("");
    }
  });
});
