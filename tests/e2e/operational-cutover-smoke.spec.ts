import { expect, test } from "@playwright/test";
import { setupStaffSession } from "./helpers/auth";

/**
 * Lightweight smoke for surfaces named in TRUTH_LAYER § Operational cutover semantics.
 * Mirrors staff-navigation patterns; requires working staff session storage (E2E harness).
 */
test.describe("Operational cutover smoke — Orders + manual count surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await setupStaffSession(page);
  });

  test("staff Orders page renders without error boundary", async ({ page }) => {
    await page.goto("/admin/orders");
    await expect(page.locator("h1")).toContainText("Orders");
    await expect(page.locator("[data-nextjs-error]")).toHaveCount(0);
  });

  test("manual inventory count page renders without error boundary", async ({ page }) => {
    await page.goto("/admin/inventory/manual-count");
    await expect(page.locator("h1")).toContainText("Manual count entry");
    await expect(page.locator("[data-nextjs-error]")).toHaveCount(0);
  });

  test("Shipping log page renders without error boundary", async ({ page }) => {
    await page.goto("/admin/shipping");
    await expect(page.locator("h1")).toContainText("Shipping Log");
    await expect(page.locator("[data-nextjs-error]")).toHaveCount(0);
  });
});
