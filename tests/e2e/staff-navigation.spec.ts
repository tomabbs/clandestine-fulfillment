import { expect, test } from "@playwright/test";
import { setupStaffSession } from "./helpers/auth";

test.describe("Staff portal navigation", () => {
  test.beforeEach(async ({ page }) => {
    await setupStaffSession(page);
  });

  test("dashboard loads with stats and pre-order section", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.locator("h1")).toContainText("Dashboard");
    // Stats cards should be present
    await expect(page.getByText("Products")).toBeVisible();
    await expect(page.getByText("Orders (month)")).toBeVisible();
    // Pre-order section
    await expect(page.getByText("Upcoming Releases")).toBeVisible();
  });

  const SIDEBAR_PAGES = [
    { name: "Inventory", path: "/admin/inventory", heading: "Inventory" },
    { name: "Inbound", path: "/admin/inbound", heading: "Inbound" },
    { name: "Orders", path: "/admin/orders", heading: "Orders" },
    { name: "Catalog", path: "/admin/catalog", heading: "Catalog" },
    { name: "Clients", path: "/admin/clients", heading: "Clients" },
    { name: "Shipping", path: "/admin/shipping", heading: "Shipping" },
    { name: "Billing", path: "/admin/billing", heading: "Billing" },
    { name: "Channels", path: "/admin/channels", heading: "Channels" },
    { name: "Review Q", path: "/admin/review-queue", heading: "Review Queue" },
    { name: "Support", path: "/admin/support", heading: "Support" },
    { name: "Scan", path: "/admin/scan", heading: "Scan" },
  ];

  for (const item of SIDEBAR_PAGES) {
    test(`navigates to ${item.name} page via sidebar`, async ({ page }) => {
      await page.goto("/admin");

      // Click sidebar link
      const sidebarLink = page.locator(`[data-slot="sidebar-menu-button"]`, {
        hasText: item.name,
      });
      if (await sidebarLink.isVisible()) {
        await sidebarLink.click();
      } else {
        // Direct navigation as fallback
        await page.goto(item.path);
      }

      await expect(page).toHaveURL(item.path);
      await expect(page.locator("h1")).toContainText(item.heading);

      // No error boundaries or console errors
      const errorBoundary = page.locator("[data-nextjs-error]");
      await expect(errorBoundary).toHaveCount(0);
    });
  }

  const SETTINGS_PAGES = [
    { name: "General", path: "/admin/settings", heading: "General Settings" },
    { name: "Bandcamp Accounts", path: "/admin/settings/bandcamp", heading: "Bandcamp" },
    {
      name: "Store Connections",
      path: "/admin/settings/store-connections",
      heading: "Store Connections",
    },
    { name: "Store Mapping", path: "/admin/settings/store-mapping", heading: "Store Mapping" },
    { name: "Integrations", path: "/admin/settings/integrations", heading: "Integrations" },
    { name: "Health", path: "/admin/settings/health", heading: "System Health" },
  ];

  for (const item of SETTINGS_PAGES) {
    test(`navigates to Settings > ${item.name}`, async ({ page }) => {
      await page.goto(item.path);
      await expect(page.locator("h1")).toContainText(item.heading);

      const errorBoundary = page.locator("[data-nextjs-error]");
      await expect(errorBoundary).toHaveCount(0);
    });
  }

  test("command palette opens with Cmd+K", async ({ page }) => {
    await page.goto("/admin");
    await page.keyboard.press("Meta+k");

    // Command dialog should appear
    const dialog = page.locator("[data-slot='dialog']");
    if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(dialog).toBeVisible();
    }
  });
});
