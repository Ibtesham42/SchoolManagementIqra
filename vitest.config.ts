import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { INTEGRATION_FLAG, SCOPE_INCLUDE, SCOPE_TIMEOUTS, testScope } from "./tests/test-scope";

// KI-043: unit tests by default; integration tests only via `npm run test:integration`.
const scope = testScope(process.env);

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Vite/Vitest would otherwise read .env, .env.local, .env.test, .env.test.local from the project
  // root into the runner process (mode "test"). Tests never need that: disable env-file loading
  // entirely. Integration runs load .env explicitly in tests/setup.ts.
  envDir: false,
  test: {
    environment: "node",
    include: SCOPE_INCLUDE[scope],
    setupFiles: ["tests/setup.ts"],
    // S-05: before any integration suite writes, prove the target is the allow-listed Test branch.
    globalSetup: scope === "integration" ? ["tests/integration-global-setup.ts"] : [],
    env: scope === "integration" ? { [INTEGRATION_FLAG]: "1" } : {},
    ...SCOPE_TIMEOUTS[scope], // integration only: 60 s per test, 180 s per setup hook; unit keeps the defaults
    // Integration suites share ONE Test database (the settings row, the current session, number formats, sequence
    // counters, synthetic session years): run the files one at a time so one suite can't change another's ground
    // mid-run. Also keeps Neon free-tier compute to one connection pool at a time.
    fileParallelism: scope !== "integration",
  },
});
