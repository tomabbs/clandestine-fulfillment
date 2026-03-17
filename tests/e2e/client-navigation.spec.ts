import { expect, test } from "@playwright/test";
import { setupClientSession } from "./helpers/auth";

test.describe("Client portal navigation", () => {
  test.beforeEach(async ({ page }) => {
    await setupClientSession(page);
  });

  test("home page loads with onboarding and stats", async ({ page }) => {
    await page.goto("/portal");
    await expect(page.locator("h1")).toContainText("Welcome");
    // Should show onboarding checklist or stats
    const pageContent = await page.textContent("body");
    expect(
      pageContent?.includes("Getting Started") || pageContent?.includes("Total SKUs"),
    ).toBeTruthy();
  });

  const PORTAL_PAGES = [
    { name: "Inventory", path: "/portal/inventory", heading: "Inventory" },
    { name: "Releases", path: "/portal/releases", heading: "Releases" },
    { name: "Inbound", path: "/portal/inbound", heading: "Inbound" },
    { name: "Orders", path: "/portal/orders", heading: "Orders" },
    { name: "Shipping", path: "/portal/shipping", heading: "Shipping" },
    { name: "Sales", path: "/portal/sales", heading: "Sales" },
    { name: "Billing", path: "/portal/billing", heading: "Billing" },
    { name: "Support", path: "/portal/support", heading: "Support" },
    { name: "Settings", path: "/portal/settings", heading: "Settings" },
  ];

  for (const item of PORTAL_PAGES) {
    test(`navigates to ${item.name} page`, async ({ page }) => {
      await page.goto(item.path);
      await expect(page.locator("h1")).toContainText(item.heading);

      const errorBoundary = page.locator("[data-nextjs-error]");
      await expect(errorBoundary).toHaveCount(0);
    });
  }

  test("client cannot access /admin pages — redirects away", async ({ page }) => {
    await page.goto("/admin");
    // Should redirect to /portal (client role) or /login
    await page.waitForURL((url) => {
      const path = url.pathname;
      return path.startsWith("/portal") || path.startsWith("/login");
    });

    const currentUrl = page.url();
    expect(currentUrl).not.toContain("/admin");
  });
});
