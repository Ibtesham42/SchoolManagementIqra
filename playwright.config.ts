import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against a running production build (`next build` → standalone server).
 * E2E_BASE_URL points at it; the server's DATABASE_URL must be a development/test database —
 * global-setup creates disposable e2e users there. Never point this at production.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3123";

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    // Each project gets its own simulated client IP so the per-IP rate limiter treats them as separate clients.
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.11" } } },
    { name: "pixel-7", use: { ...devices["Pixel 7"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.12" } } },
    { name: "iphone-14", use: { ...devices["iPhone 14"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.13" } } },
  ],
});
