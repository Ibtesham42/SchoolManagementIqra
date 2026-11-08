import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const key = () => randomBytes(32).toString("base64");
const base = {
  DATABASE_URL: "postgresql://u:p@db.example.test/x",
  SESSION_SECRET: randomBytes(32).toString("base64"),
  DATA_ENCRYPTION_KEY: key(),
  DATA_HMAC_KEY: key(),
};

async function load(env: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
  return (await import("@/lib/env")).getEnv;
}

afterEach(() => vi.unstubAllEnvs());

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
  it("defaults every optional paid-capable provider to a no-cost mode", async () => {
    const env = (await load({ APP_URL: "http://localhost:3000" }))();
    expect(env.AI_PROVIDER).toBe("none");
    expect(env.AI_DAILY_REQUEST_LIMIT).toBe(0);
    expect(env.EMAIL_PROVIDER).toBe("log");
  });
});
