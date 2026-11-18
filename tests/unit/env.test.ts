import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const key = () => randomBytes(32).toString("base64");
const base = {
  DATABASE_URL: "postgresql://u:p@db.example.test/x",
  SESSION_SECRET: randomBytes(32).toString("base64"),
  DATA_ENCRYPTION_KEY: key(),
  DATA_HMAC_KEY: key(),
  DOCUMENT_VERIFICATION_KEY: key(),
};

async function load(env: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
  return (await import("@/lib/env")).getEnv;
}

afterEach(() => vi.unstubAllEnvs());

/** Loads a fresh module and calls getEnv() (async, so rejections are easy to assert). */
async function getEnvWith(env: Record<string, string>) {
  return (await load({ APP_URL: "http://localhost:3000", ...env }))();
}

describe("environment validation", () => {
  it("rejects http APP_URL in production for non-local hosts", async () => {
    const getEnv = await load({ NODE_ENV: "production", APP_URL: "http://school.example.test" });
    expect(() => getEnv()).toThrow(/https/);
  });
  it("allows https in production and http on localhost", async () => {
    expect((await load({ NODE_ENV: "production", APP_URL: "https://school.example.test" }))().APP_URL).toMatch(/^https/);
    expect((await load({ NODE_ENV: "production", APP_URL: "http://127.0.0.1:3000" }))().APP_URL).toMatch(/127/);
  });
  it("rejects wrong-length encryption keys and reports names only", async () => {
    const getEnv = await load({ APP_URL: "http://localhost:3000", DATA_ENCRYPTION_KEY: "c2hvcnQ=" });
    expect(() => getEnv()).toThrow(/DATA_ENCRYPTION_KEY: must be 32 bytes/);
    try {
      getEnv();
    } catch (e) {
      expect((e as Error).message).not.toContain("c2hvcnQ=");
    }
  });
  it("requires a dedicated 32-byte DOCUMENT_VERIFICATION_KEY", async () => {
    await expect(getEnvWith({ DOCUMENT_VERIFICATION_KEY: "" })).rejects.toThrow(/DOCUMENT_VERIFICATION_KEY/);
    await expect(getEnvWith({ DOCUMENT_VERIFICATION_KEY: "c2hvcnQ=" })).rejects.toThrow(/DOCUMENT_VERIFICATION_KEY: must be 32 bytes/);
  });
  it("refuses to reuse DATA_HMAC_KEY or DATA_ENCRYPTION_KEY as the verification key (names only)", async () => {
    await expect(getEnvWith({ DOCUMENT_VERIFICATION_KEY: base.DATA_HMAC_KEY })).rejects.toThrow(/DATA_HMAC_KEY and DOCUMENT_VERIFICATION_KEY must be different/);
    await expect(getEnvWith({ DOCUMENT_VERIFICATION_KEY: base.DATA_ENCRYPTION_KEY })).rejects.toThrow(/DATA_ENCRYPTION_KEY and DOCUMENT_VERIFICATION_KEY must be different/);
    const message = await getEnvWith({ DOCUMENT_VERIFICATION_KEY: base.DATA_HMAC_KEY }).catch((e: Error) => e.message);
    expect(message).not.toContain(base.DATA_HMAC_KEY); // names only, never values
  });
  it("validates rotated-out verification keys", async () => {
    const old = key();
    const env = await getEnvWith({ DOCUMENT_VERIFICATION_KEY_VERSION: "2", DOCUMENT_VERIFICATION_KEY_V1: old });
    expect(env.DOCUMENT_VERIFICATION_KEY_VERSION).toBe(2);
    await expect(getEnvWith({ DOCUMENT_VERIFICATION_KEY_VERSION: "2", DOCUMENT_VERIFICATION_KEY_V1: "c2hvcnQ=" })).rejects.toThrow(/DOCUMENT_VERIFICATION_KEY_V1: must be 32 bytes/);
    await expect(getEnvWith({ DOCUMENT_VERIFICATION_KEY_VERSION: "2", DOCUMENT_VERIFICATION_KEY_V2: old })).rejects.toThrow(/V2: version 2 is the current version/);
    await expect(getEnvWith({ DOCUMENT_VERIFICATION_KEY_VERSION: "2", DOCUMENT_VERIFICATION_KEY_V1: base.DOCUMENT_VERIFICATION_KEY })).rejects.toThrow(/V1 must differ from DOCUMENT_VERIFICATION_KEY/);
    await expect(getEnvWith({ DOCUMENT_VERIFICATION_KEY_VERSION: "0" })).rejects.toThrow(/DOCUMENT_VERIFICATION_KEY_VERSION/);
    // Non-canonical names would never be loaded — reject them at start-up instead of ignoring them silently.
    for (const name of ["DOCUMENT_VERIFICATION_KEY_V01", "DOCUMENT_VERIFICATION_KEY_V+1", "DOCUMENT_VERIFICATION_KEY_V1A", "DOCUMENT_VERIFICATION_KEY_V40000"]) {
      await expect(getEnvWith({ DOCUMENT_VERIFICATION_KEY_VERSION: "2", [name]: old })).rejects.toThrow(/not a valid rotated-key name/);
    }
  });
  it("defaults every optional paid-capable provider to a no-cost mode", async () => {
    const env = (await load({ APP_URL: "http://localhost:3000" }))();
    expect(env.AI_PROVIDER).toBe("none");
    expect(env.AI_DAILY_REQUEST_LIMIT).toBe(0);
    expect(env.EMAIL_PROVIDER).toBe("log");
  });
});
