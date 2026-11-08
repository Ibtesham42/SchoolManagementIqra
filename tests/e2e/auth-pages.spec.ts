import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Public auth screens. These are designed to behave identically with or without a reachable
 * database (no account enumeration, no internals), so this suite runs in both setups.
 */
const LEAKS = /prisma|ECONNREFUSED|postgres(ql)?:\/\/|stack trace|at \w+ \(/i;

async function a11y(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function touchTargetsAtLeast44(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) >= 640) return; // rule applies below the sm breakpoint
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("main button, main a, main input:not([type=hidden]), main select")]
      .filter((el) => el.offsetParent !== null && el.getAttribute("type") !== "checkbox" && el.getAttribute("role") !== "checkbox")
      .map((el) => ({ el: el.outerHTML.slice(0, 80), h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 44),
  );
  expect(small).toEqual([]);
}

test("login page: labelled form, forgot-password link, accessible, mobile-safe", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByRole("checkbox", { name: /Keep me signed in/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/forgot-password");
  await a11y(page);
  await noHorizontalScroll(page);
  await touchTargetsAtLeast44(page);
});

test("empty login shows a validation message without a round-trip error", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator('form [role="alert"]')).toHaveText("Enter your username and password.");
});

test("forgot password: same neutral confirmation for any identifier (no enumeration)", async ({ page }) => {
  const messages: string[] = [];
  for (const id of ["someone-who-does-not-exist", "superadmin"]) {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { level: 1, name: "Reset your password" })).toBeVisible();
    await page.getByLabel("Username or email").fill(id);
    await page.getByRole("button", { name: "Send reset link" }).click();
    const status = page.locator('form [role="status"], form [role="alert"]');
    await expect(status).toBeVisible();
    messages.push((await status.innerText()).trim());
    expect(await page.content()).not.toMatch(LEAKS);
  }
  expect(messages[0]).toBe(messages[1]);
  expect(messages[0]).toMatch(/If an account|Too many attempts/);
  await a11y(page);
  await noHorizontalScroll(page);
});

test("reset password: missing or bogus token shows a clear invalid-link message", async ({ page }) => {
  for (const url of ["/reset-password", "/reset-password?token=not-a-real-token-0123456789abcdef"]) {
    await page.goto(url);
    await expect(page.locator('main [role="alert"]')).toContainText("invalid or has expired");
    await expect(page.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/forgot-password");
    await expect(page.getByLabel("New password")).toHaveCount(0);
    expect(await page.content()).not.toMatch(LEAKS);
  }
  await a11y(page);
});

test("reset token in the URL fragment is stripped from the address bar immediately", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/reset-password#token=not-a-real-token-0123456789abcdef");
  await expect(page.locator('main [role="alert"]')).toContainText("invalid or has expired");
  expect(new URL(page.url()).hash).toBe(""); // removed from history/address bar
  // The token never appears in any URL the browser requested (fragments aren't sent; it's POSTed in the body).
  expect(requests.filter((u) => u.includes("not-a-real-token"))).toEqual([]);
});

test("pages ship a nonce-based CSP, aren't cached, and run without CSP violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) violations.push(m.text());
  });
  for (const path of ["/login", "/forgot-password", "/reset-password", "/"]) {
    const res = await page.goto(path);
    const csp = res!.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(res!.headers()["cache-control"] ?? "").toMatch(/no-store|private/);
  }
  // Hydration works under the CSP: a client-side interaction updates the page.
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator('form [role="alert"]')).toHaveText("Enter your username and password.");
  expect(violations).toEqual([]);
});

test("reset-password page sends no Referer (token must not leak to other sites)", async ({ page }) => {
  await page.goto("/reset-password?token=not-a-real-token-0123456789abcdef");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
});

test("cron cleanup endpoint rejects requests without the secret", async ({ request }) => {
  const res = await request.post("/api/cron/cleanup");
  expect(res.status()).toBe(401);
  const wrong = await request.post("/api/cron/cleanup", { headers: { authorization: "Bearer wrong-secret-wrong-secret-wrong-secret" } });
  expect(wrong.status()).toBe(401);
  expect(await wrong.text()).not.toMatch(LEAKS);
});

test("ERP admin routes require a session", async ({ page }) => {
  for (const path of ["/erp/users", "/erp/users/new", "/erp/roles", "/erp/roles/new", "/erp/account"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});
