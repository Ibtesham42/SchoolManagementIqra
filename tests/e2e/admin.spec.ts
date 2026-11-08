import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * PENDING until a seeded development/test database is available (E2E_DATABASE_URL).
 * Uses the ready-to-use admin (no pending password change) and teacher created by global-setup.
 */
test.describe.configure({ mode: "serial" });
test.skip(!process.env.E2E_DATABASE_URL, "PENDING: needs a seeded development/test database (E2E_DATABASE_URL)");

type Creds = { admin: string; readyAdmin: string; teacher: string; password: string; newPassword: string };
const creds = (project: string): Creds => JSON.parse(readFileSync("playwright/.cache/e2e-credentials.json", "utf8"))[project];

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function a11y(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
}

test("Super Admin creates a user; the user must change the temporary password", async ({ page, browser }, info) => {
  const c = creds(info.project.name);
  await login(page, c.readyAdmin, c.password);
  await page.goto("/erp/users/new");
  const username = `e2e-new-${info.project.name}-${Date.now().toString(36)}`;
  await page.getByLabel("Full name").fill("E2E New Teacher");
  await page.getByLabel("Username").fill(username);
  await page.getByRole("checkbox", { name: /^Teacher/ }).check();
  await page.getByRole("button", { name: "Create user" }).click();
  const secret = (await page.getByTestId("one-time-secret").innerText()).trim();
  expect(secret).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
  await a11y(page);

  const other = await browser.newPage();
  await login(other, username, secret);
  await expect(other).toHaveURL(/\/erp\/change-password$/);
  await other.close();
});

test("teacher sees no admin navigation and is refused on admin pages", async ({ page }, info) => {
  const c = creds(info.project.name);
  await login(page, c.teacher, c.password);
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Roles" })).toHaveCount(0);
  for (const path of ["/erp/users", "/erp/roles", "/erp/users/new"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "You don't have access to this page" })).toBeVisible();
  }
});

test("Super Admin role is shown read-only; custom role lifecycle works", async ({ page }, info) => {
  const c = creds(info.project.name);
  await login(page, c.readyAdmin, c.password);
  await page.goto("/erp/roles");
  await page.getByRole("link", { name: /Super Admin/ }).click();
  await expect(page.getByText("System roles cannot be modified.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save permissions" })).toHaveCount(0);

  await page.goto("/erp/roles/new");
  const key = `E2E_${info.project.name.replace(/\W/g, "_").toUpperCase()}_${Date.now().toString(36).toUpperCase()}`;
  await page.getByLabel("Name").fill("E2E Coordinator");
  await page.getByLabel("Key").fill(key);
  await page.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByRole("heading", { name: "E2E Coordinator" })).toBeVisible();
  await page.getByLabel(/View timetables/).selectOption("ALL");
  await page.getByRole("button", { name: "Save permissions" }).click();
  await expect(page.getByText(/Saved 1 permission/)).toBeVisible();
  await page.getByRole("button", { name: "Delete role" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/erp\/roles$/);
});
