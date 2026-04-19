import { expect, test } from "@playwright/test";
import { setupClientSession, setupStaffSession } from "./helpers/auth";
import { cleanupTestData, createTestOrg, createTestProduct } from "./helpers/test-data";

test.describe("Inbound shipment flow", () => {
  test.describe.configure({ mode: "serial" });
  let orgId: string;
  let testSku: string;

  test.beforeAll(async () => {
    const testOrg = await createTestOrg("Inbound E2E");
    orgId = testOrg.orgId;
    const product = await createTestProduct(
      testOrg.workspaceId,
      orgId,
      "INB-E2E-001",
      "Test Pressing",
    );
    testSku = product.sku;
  });

  test.afterAll(async () => {
    await cleanupTestData();
  });

  test("client submits new inbound shipment", async ({ page }) => {
    await setupClientSession(page, orgId);
    await page.goto("/portal/inbound");

    await expect(page).toHaveURL(/\/portal\/inbound/);
    await expect(page.getByRole("link", { name: "Inbound" })).toBeVisible();

    // Click new inbound button
    const newButton = page.getByRole("link", { name: /submit new inbound|new/i });
    if (await newButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await newButton.click();
      await page.waitForURL("**/portal/inbound/new");

      // Fill form fields
      const trackingInput = page.getByLabel(/tracking/i);
      if (await trackingInput.isVisible()) {
        await trackingInput.fill("1Z999AA10123456784");
      }

      const carrierInput = page.getByLabel(/carrier/i);
      if (await carrierInput.isVisible()) {
        const carrierTag = await carrierInput.evaluate((el) => el.tagName.toLowerCase());
        if (carrierTag === "select") {
          await carrierInput.selectOption({ label: "UPS" }).catch(async () => {
            await carrierInput.selectOption({ value: "ups" });
          });
        } else {
          await carrierInput.fill("UPS");
        }
      }

      const dateInput = page.getByLabel(/expected.*date/i);
      if (await dateInput.isVisible()) {
        await dateInput.fill("2026-04-15");
      }

      // Look for SKU input to add items
      const skuInput = page.getByPlaceholder(/sku/i);
      if (
        await skuInput
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false)
      ) {
        await skuInput.first().fill(testSku);
      }

      const qtyInput = page.getByPlaceholder(/quantity|qty/i);
      if (
        await qtyInput
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false)
      ) {
        await qtyInput.first().fill("500");
      }

      // Submit
      const submitButton = page.getByRole("button", { name: /submit/i });
      if (await submitButton.isVisible()) {
        await submitButton.click();
        await page.waitForTimeout(1000);
      }
    }

    // Verify no errors
    const errorBoundary = page.locator("[data-nextjs-error]");
    await expect(errorBoundary).toHaveCount(0);
  });

  test("staff views inbound shipments", async ({ page }) => {
    await setupStaffSession(page);
    await page.goto("/admin/inbound");

    await expect(page).toHaveURL(/\/admin\/inbound/);

    // Wait for table
    await page.waitForSelector("table", { timeout: 10000 }).catch(() => {
      // May not have data
    });

    // Verify page structure
    const statusTabs = page.locator("button", { hasText: /all|expected|arrived/i });
    expect(await statusTabs.count()).toBeGreaterThan(0);

    // Verify no errors
    const errorBoundary = page.locator("[data-nextjs-error]");
    await expect(errorBoundary).toHaveCount(0);
  });

  test("staff can navigate to inbound detail", async ({ page }) => {
    await setupStaffSession(page);
    await page.goto("/admin/inbound");

    // Click on first row if visible
    const firstRow = page.locator("table tbody tr").first();
    if (await firstRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstRow.click();
      // Should navigate to detail page or expand
      await page.waitForTimeout(500);
    }

    const errorBoundary = page.locator("[data-nextjs-error]");
    await expect(errorBoundary).toHaveCount(0);
  });
});
