import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Phase 6A-M4 — parent portal journeys (PHASE_6_PLAN.md §7 E2E). The first group runs with or without a database
 * (public pages behave the same); the journey needs a seeded development/test database (E2E_DATABASE_URL) and the
 * synthetic family created by global-setup (tests/e2e/portal-fixture.ts).
 */
async function a11y(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.nodes.length})`)).toEqual([]);
}
async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test.describe("portal — public pages", () => {
  test("/activate: labelled form with consent, accessible, mobile-safe; a fragment code is read and removed from the address", async ({ page }) => {
    await page.goto("/activate#u=9000000001&code=ABCD-EFGH-JKMN");
    await expect(page.getByRole("heading", { level: 1, name: "Activate your portal account" })).toBeVisible();
    await expect(page.getByLabel("Username")).toHaveValue("9000000001");
    await expect(page.getByLabel("Activation code")).toHaveValue("ABCD-EFGH-JKMN");
    await expect(page).toHaveURL(/\/activate$/); // the fragment is gone from the address bar and history
    await expect(page.getByLabel("Your child's date of birth")).toHaveAttribute("type", "date");
    await expect(page.getByRole("checkbox", { name: /privacy notice/ })).toBeVisible();
    await a11y(page);
    await noHorizontalScroll(page);
  });

  test("/activate without consent is refused before anything else", async ({ page }) => {
    await page.goto("/activate");
    await page.getByLabel("Username").fill("9000000001");
    await page.getByLabel("Activation code").fill("ABCD-EFGH-JKMN");
    await page.getByLabel("Your child's date of birth").fill("2016-03-04");
    await page.getByLabel("New password").fill("A-long-enough-pass");
    await page.getByLabel("Confirm new password").fill("A-long-enough-pass");
    await page.getByRole("button", { name: "Activate my account" }).click();
    await expect(page.locator('form [role="alert"]')).toContainText("tick the box to agree");
  });

  test("signed out: /portal pages send you to sign in; the login page links to activation", async ({ page }) => {
    for (const path of ["/portal", "/portal/account", "/portal/c/c0000000000000000000000000/profile"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
    await expect(page.getByRole("link", { name: /Activate your account/ })).toHaveAttribute("href", "/activate");
  });
});

type Fixture = { username: string; code: string; dob: string; childName: string; ownStudentId: string; otherStudentId: string };
type Creds = { newPassword: string; portal?: Fixture };
const creds = (project: string): Creds => JSON.parse(readFileSync("playwright/.cache/e2e-credentials.json", "utf8"))[project];

test.describe("portal — parent journey", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!process.env.E2E_DATABASE_URL, "PENDING: needs a seeded development/test database (E2E_DATABASE_URL)");

  test("activate from the slip → portal home → profile; another family's child is a 404; the ERP sends you back", async ({ page, context }, info) => {
    const c = creds(info.project.name);
    const f = c.portal!;
    await page.goto("/activate");
    await page.getByLabel("Username").fill(f.username);
    await page.getByLabel("Activation code").fill(f.code.toLowerCase()); // case and dashes don't matter
    await page.getByLabel("Your child's date of birth").fill(f.dob);
    await page.getByRole("checkbox", { name: /privacy notice/ }).check();
    await page.getByLabel("New password").fill(c.newPassword);
    await page.getByLabel("Confirm new password").fill(c.newPassword);
    await page.getByRole("button", { name: "Activate my account" }).click();
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByRole("heading", { level: 1, name: /^Welcome/ })).toBeVisible();
    await a11y(page);
    await noHorizontalScroll(page);

    await page.getByRole("link", { name: new RegExp(f.childName) }).first().click();
    await expect(page).toHaveURL(new RegExp(`/portal/c/${f.ownStudentId}/profile$`));
    await expect(page.getByRole("heading", { level: 1, name: f.childName })).toBeVisible();
    await expect(page.getByText("Student ID")).toBeVisible();
    await a11y(page);
    await noHorizontalScroll(page);

    // URL tampering with another family's child id → the same 404 as a missing page.
    const other = await page.goto(`/portal/c/${f.otherStudentId}/profile`);
    expect(other?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    const missing = await page.goto("/portal/c/c0000000000000000000000000/profile");
    expect(missing?.status()).toBe(404);

    // A portal account never renders the ERP.
    await page.goto("/erp/fees");
    await expect(page).toHaveURL(/\/portal$/);

    // Account: sign out other devices.
    await page.goto("/portal/account");
    await page.getByRole("button", { name: "Sign out other devices" }).click();
    await expect(page.getByText(/other device/)).toBeVisible();
    await a11y(page);

    // Sign out, sign in again with "keep me signed in": a long session for a portal account.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Username").fill(f.username);
    await page.getByLabel("Password", { exact: true }).fill(c.newPassword);
    await page.getByRole("checkbox", { name: /Keep me signed in/ }).check();
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/portal$/);
    const cookie = (await context.cookies()).find((k) => k.name === "sid" || k.name === "__Host-sid");
    expect(cookie && cookie.expires * 1000 - Date.now()).toBeGreaterThan(20 * 86_400_000);
  });

  test("the activation code works only once", async ({ page }, info) => {
    const c = creds(info.project.name);
    const f = c.portal!;
    await page.goto("/activate");
    await page.getByLabel("Username").fill(f.username);
    await page.getByLabel("Activation code").fill(f.code);
    await page.getByLabel("Your child's date of birth").fill(f.dob);
    await page.getByRole("checkbox", { name: /privacy notice/ }).check();
    await page.getByLabel("New password").fill(`${c.newPassword}-x`);
    await page.getByLabel("Confirm new password").fill(`${c.newPassword}-x`);
    await page.getByRole("button", { name: "Activate my account" }).click();
    await expect(page.locator('form [role="alert"]')).toContainText("These details don't match");
  });
});
