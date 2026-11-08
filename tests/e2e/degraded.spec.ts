import { expect, test } from "@playwright/test";

/**
 * Degraded-database behaviour. Requires a second server instance whose DATABASE_URL is
 * unreachable, at E2E_DEGRADED_BASE_URL. Skipped otherwise.
 */
const base = process.env.E2E_DEGRADED_BASE_URL;
const LEAKS = /prisma|ECONNREFUSED|postgres(ql)?:\/\/|stack trace|at \w+ \(/i;

test.describe("database unreachable", () => {
  test.skip(!base, "E2E_DEGRADED_BASE_URL not set");

  test("liveness stays up without touching the DB; deep check is secret-protected and reports degraded", async ({ request }) => {
    const live = await request.get(`${base}/api/health`);
    expect(live.status()).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });
    const anon = await request.get(`${base}/api/health?deep=1`);
    expect(anon.status()).toBe(401);
    const secret = process.env.E2E_CRON_SECRET;
    test.skip(!secret, "E2E_CRON_SECRET not set — deep check not exercised");
    const deep = await request.get(`${base}/api/health?deep=1`, { headers: { authorization: `Bearer ${secret}` } });
    expect(deep.status()).toBe(503);
    expect(await deep.json()).toEqual({ status: "degraded", database: "unreachable" });
  });

  test("public homepage and login page still render", async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto(`${base}/login`);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("login page renders even with a stale session cookie", async ({ page, context }) => {
    await context.addCookies([{ name: "sid", value: "stale-session-token-0123456789", url: base! }]);
    await page.goto(`${base}/login`);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("a login attempt fails with a generic message", async ({ page }) => {
    await page.goto(`${base}/login`);
    await page.getByLabel("Username").fill("someone");
    await page.getByLabel("Password", { exact: true }).fill("whatever-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator('form [role="alert"]')).toHaveText("Something went wrong. Please try again.");
    expect(await page.content()).not.toMatch(LEAKS);
  });

  test("ERP with a session cookie shows a friendly error with a reference, no internals", async ({ page, context }) => {
    await context.addCookies([{ name: "sid", value: "stale-session-token-0123456789", url: base! }]);
    await page.goto(`${base}/erp`);
    await expect(page.getByRole("heading", { name: "The service is temporarily unavailable" })).toBeVisible();
    await expect(page.getByText(/Reference: \w+/)).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(LEAKS);
  });
});
