import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTEGRATION_FLAG, SCOPE_INCLUDE, integrationEnabled, testScope } from "../test-scope";

/**
 * KI-043: `npm test` and `npm run test:unit` are offline; integration tests run only through
 * `npm run test:integration`. These checks need no database and never load `.env`.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("scope selection", () => {
  it.each([
    ["test", "unit"], // npm test
    ["test:unit", "unit"], // npm run test:unit
    [undefined, "unit"], // npx vitest … (no npm script)
    ["test:e2e", "unit"],
    ["test:integration", "integration"], // npm run test:integration — the only way in
  ] as const)("npm_lifecycle_event=%s → %s", (event, scope) => {
    expect(testScope({ npm_lifecycle_event: event })).toBe(scope);
  });
  it("unit scope collects only tests/unit; integration scope only tests/integration", () => {
    expect(SCOPE_INCLUDE.unit).toEqual(["tests/unit/**/*.test.ts"]);
    expect(SCOPE_INCLUDE.integration).toEqual(["tests/integration/**/*.test.ts"]);
  });
  it("a TEST_DATABASE_URL alone never enables integration tests — the explicit flag is required", () => {
    expect(integrationEnabled({ TEST_DATABASE_URL: "postgresql://u:p@x.invalid/db" })).toBe(false);
    expect(integrationEnabled({ [INTEGRATION_FLAG]: "1" })).toBe(false);
    expect(integrationEnabled({ [INTEGRATION_FLAG]: "true", TEST_DATABASE_URL: "postgresql://u:p@x.invalid/db" })).toBe(false);
    expect(integrationEnabled({ [INTEGRATION_FLAG]: "1", TEST_DATABASE_URL: "postgresql://u:p@x.invalid/db" })).toBe(true);
  });
});

describe("vitest.config.ts", () => {
  const load = async (event: string | undefined) => {
    vi.resetModules();
    vi.stubEnv("npm_lifecycle_event", event as string);
    const cfg = (await import("../../vitest.config")).default as { test: { include: string[]; env: Record<string, string> } };
    return cfg.test;
  };
  it.each(["test", "test:unit", undefined])("for %s: unit files only, no opt-in flag", async (event) => {
    const t = await load(event);
    expect(t.include).toEqual(SCOPE_INCLUDE.unit);
    expect(t.env[INTEGRATION_FLAG]).toBeUndefined();
  });
  it("Vite/Vitest never load env files (envDir: false)", async () => {
    vi.resetModules();
    const cfg = (await import("../../vitest.config")).default as { envDir: unknown };
    expect(cfg.envDir).toBe(false);
  });
  it("for test:integration: integration files only, with the opt-in flag", async () => {
    const t = await load("test:integration");
    expect(t.include).toEqual(SCOPE_INCLUDE.integration);
    expect(t.env[INTEGRATION_FLAG]).toBe("1");
  });
});

describe("this unit run is offline", () => {
  it("has no opt-in flag and no database URL in the process", () => {
    expect(process.env[INTEGRATION_FLAG]).toBeUndefined();
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.DIRECT_URL).toBeUndefined();
    expect(process.env.TEST_DATABASE_URL).toBeUndefined();
  });
  it("the Prisma client refuses to connect (no URL) instead of reaching any database", async () => {
    const { prisma } = await import("@/lib/db");
    expect(() => prisma.user).toThrow(/DATABASE_URL is not set/);
  });
});

describe("wiring", () => {
  it("setup loads .env only in integration scope (never `dotenv/config` at import)", () => {
    const setup = read("../setup.ts");
    expect(setup).not.toMatch(/import\s+["']dotenv\/config["']/);
    expect(setup).toMatch(new RegExp(`if \\(process\\.env\\[INTEGRATION_FLAG\\] === "1"\\) \\{[\\s\\S]*config\\(`));
  });
  it("every integration test file is gated by integrationEnabled(), not by TEST_DATABASE_URL alone", () => {
    const dir = new URL("../integration/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).toMatch(/const enabled = integrationEnabled\(\);/);
      expect(src, f).not.toMatch(/const enabled = !!process\.env\.TEST_DATABASE_URL/);
      expect(src, f).toMatch(/describe\.skipIf\(!enabled\)/);
    }
  });
  it("npm scripts: test and test:unit are unit-only; test:integration is the explicit opt-in; CI runs unit tests", () => {
    const scripts = JSON.parse(read("../../package.json")).scripts as Record<string, string>;
    expect(scripts.test).toBe("vitest run");
    expect(scripts["test:unit"]).toBe("vitest run tests/unit");
    expect(scripts["test:integration"]).toBe("vitest run tests/integration");
    expect(read("../../.github/workflows/ci.yml")).toMatch(/npm run test:unit/);
    expect(read("../../.github/workflows/ci.yml")).not.toMatch(/test:integration/);
  });
});
