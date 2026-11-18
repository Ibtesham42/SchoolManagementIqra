/**
 * Which tests a Vitest run may touch (KI-043).
 *
 * - `npm test`, `npm run test:unit`, `npx vitest …`  → UNIT scope: only tests/unit, `.env` is never
 *   loaded and every database URL is removed from the test process — it cannot reach a database.
 * - `npm run test:integration`                        → INTEGRATION scope: only tests/integration,
 *   `.env` is loaded and the opt-in flag below is set.
 *
 * The decision uses `npm_lifecycle_event` (set by npm to the script name, identical on Windows,
 * macOS, Linux and CI). An integration test additionally requires the flag AND TEST_DATABASE_URL,
 * so a configured `.env` alone can never start one.
 */
export type TestScope = "unit" | "integration";

/** Set only by vitest.config.ts in integration scope. */
export const INTEGRATION_FLAG = "SCHOOL_ERP_INTEGRATION_TESTS";

export const INTEGRATION_SCRIPT = "test:integration";

export function testScope(env: Record<string, string | undefined>): TestScope {
  return env.npm_lifecycle_event === INTEGRATION_SCRIPT ? "integration" : "unit";
}

/**
 * Per-scope Vitest limits. Unit scope keeps Vitest's defaults (5 s / 10 s). Integration scope talks
 * to a remote Neon branch, so tests and setup hooks get more time (KI-044).
 */
export const SCOPE_TIMEOUTS: Record<TestScope, { testTimeout?: number; hookTimeout?: number }> = {
  unit: {},
  integration: { testTimeout: 60_000, hookTimeout: 180_000 },
};

export const SCOPE_INCLUDE: Record<TestScope, string[]> = {
  unit: ["tests/unit/**/*.test.ts"],
  integration: ["tests/integration/**/*.test.ts"],
};

/** Gate used by every integration test file: explicit opt-in AND a test database URL. */
export function integrationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[INTEGRATION_FLAG] === "1" && !!env.TEST_DATABASE_URL;
}
