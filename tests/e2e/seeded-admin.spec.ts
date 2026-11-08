import { expect, test } from "@playwright/test";

/**
 * Verifies the Super Admin created by `npm run db:seed` can sign in and is forced to change
 * the seed password. Credentials come from the same env vars the seed used; skipped otherwise.
 * Runs on desktop only (one account, one-time forced change).
 */
const username = process.env.E2E_SEED_ADMIN_USERNAME;
const password = process.env.E2E_SEED_ADMIN_PASSWORD;

test("seeded Super Admin signs in and must change the seed password", async ({ page }, info) => {
  test.skip(!username || !password, "E2E_SEED_ADMIN_USERNAME/PASSWORD not set");
  test.skip(info.project.name !== "desktop-chrome", "single shared account — desktop only");
  await page.goto("/login");
  await page.getByLabel("Username").fill(username!);
  await page.getByLabel("Password", { exact: true }).fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/erp\/change-password$/);
  await expect(page.getByText("You must set a new password before continuing.")).toBeVisible();
  await expect(page.getByText("Super Admin", { exact: true })).toBeVisible();
});
