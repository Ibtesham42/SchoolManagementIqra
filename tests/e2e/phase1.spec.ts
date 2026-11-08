import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

type Creds = { admin: string; teacher: string; password: string; newPassword: string };
const creds = (project: string): Creds =>
  JSON.parse(readFileSync("playwright/.cache/e2e-credentials.json", "utf8"))[project];

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.configure({ mode: "serial" });
test.skip(!process.env.E2E_DATABASE_URL, "PENDING: needs a seeded development/test database (E2E_DATABASE_URL)");

test("public homepage shows the configured school name and portal link", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Demo Public School");
  await expect(page.getByRole("link", { name: "Portal sign in" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
});

test("ERP requires a session", async ({ page }) => {
  await page.goto("/erp");
  await expect(page).toHaveURL(/\/login$/);
});

test("wrong password gives a generic error and no session", async ({ page }, info) => {
  const c = creds(info.project.name);
  await login(page, c.teacher, "definitely-wrong-password");
  await expect(page.locator('form [role="alert"]')).toHaveText("Invalid username or password.");
  await page.goto("/erp");
  await expect(page).toHaveURL(/\/login$/);
  await expectNoSeriousA11yViolations(page);
});

test("forced password change cannot be bypassed, then the dashboard works", async ({ page }, info) => {
  const c = creds(info.project.name);
  await login(page, c.admin, c.password);
  await expect(page).toHaveURL(/\/erp\/change-password$/);
  await expect(page.getByText("You must set a new password before continuing.")).toBeVisible();

  // Bypass attempts: direct URL and client-side navigation via the nav link.
  await page.goto("/erp");
  await expect(page).toHaveURL(/\/erp\/change-password$/);
  const dashLink = page.getByRole("link", { name: "Dashboard" }).first();
  if (await dashLink.isVisible()) {
    await dashLink.click();
    await expect(page).toHaveURL(/\/erp\/change-password$/);
  }
  await expectNoSeriousA11yViolations(page);

  await page.getByLabel("Current password").fill(c.password);
  await page.getByLabel("New password", { exact: true }).fill(c.newPassword);
  await page.getByLabel("Confirm new password").fill(c.newPassword);
  await page.getByRole("button", { name: "Update password" }).click();

  await expect(page).toHaveURL(/\/erp$/);
  await expect(page.getByRole("heading", { name: "Welcome, E2E Admin" })).toBeVisible();
  await expect(page.getByText("Signed in as Super Admin")).toBeVisible();
  // Super Admin holds usage.read → free-tier panel visible.
  await expect(page.getByRole("heading", { name: "Free-tier usage today" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/erp");
  await expect(page).toHaveURL(/\/login$/);
});

test("teacher sees the dashboard without admin-only panels", async ({ page }, info) => {
  const c = creds(info.project.name);
  await login(page, c.teacher, c.password);
  await expect(page).toHaveURL(/\/erp$/);
  await expect(page.getByText("Signed in as Teacher")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Free-tier usage today" })).toHaveCount(0);
});

test("navigation adapts: sidebar on desktop, bottom bar on phones", async ({ page }, info) => {
  const c = creds(info.project.name);
  await login(page, c.teacher, c.password);
  await expect(page).toHaveURL(/\/erp$/);
  const isMobile = info.project.name !== "desktop-chrome";
  const sidebar = page.locator("aside");
  const bottomBar = page.locator("nav.fixed");
  if (isMobile) {
    await expect(sidebar).toBeHidden();
    await expect(bottomBar).toBeVisible();
    const box = await bottomBar.getByRole("link").first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44); // touch target
  } else {
    await expect(sidebar).toBeVisible();
    await expect(bottomBar).toBeHidden();
  }
  await expectNoHorizontalScroll(page);
});

test("account locks after 5 failures with the same generic message", async ({ page }, info) => {
  const c = creds(info.project.name);
  for (let i = 0; i < 5; i++) {
    await login(page, c.teacher, `wrong-password-${i}`);
    await expect(page.locator('form [role="alert"]')).toHaveText("Invalid username or password.");
  }
  await login(page, c.teacher, c.password); // correct password while locked
  await expect(page.locator('form [role="alert"]')).toHaveText("Invalid username or password.");
  await expect(page).toHaveURL(/\/login$/);
});
