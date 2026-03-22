import { expect, test } from "@playwright/test";
import { setupStaffSession } from "./helpers/auth";

test.setTimeout(90_000);

test("store mapping assigned-client dropdown loads and shows clients", async ({ page }) => {
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const serverActionResults: string[] = [];

  // Capture all console output
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors.push(text);
    }
    // Capture any logs that might reveal action results
    if (
      text.includes("getOrganizations") ||
      text.includes("organization") ||
      text.includes("Error") ||
      text.includes("Unauthorized")
    ) {
      serverActionResults.push(`[${msg.type()}] ${text}`);
    }
  });

  // Capture failed network requests
  page.on("requestfailed", (req) => {
    networkErrors.push(`FAILED: ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });

  // Capture server action 500s
  page.on("response", (response) => {
    if (
      response.status() >= 400 &&
      (response.url().includes("/admin/settings/store-mapping") ||
        response.url().includes("action"))
    ) {
      networkErrors.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });

  await setupStaffSession(page);
  await page.goto("/admin/settings/store-mapping", { waitUntil: "networkidle", timeout: 30_000 });

  // Wait for the table to appear
  await page.waitForSelector("table", { timeout: 15_000 });

  // Find the first "Assign client..." button
  const assignButtons = page.getByRole("button", { name: /assign client/i });
  const count = await assignButtons.count();
  console.log(`Found ${count} "Assign client..." buttons`);

  if (count === 0) {
    console.log("No assign buttons found — page HTML:", await page.content());
    throw new Error("No assign buttons found on store mapping page");
  }

  // Click the first one
  await assignButtons.first().click();

  // Wait a moment for the dropdown to appear and query to fire
  await page.waitForTimeout(4000);

  // Capture dropdown content
  const dropdownText = await page
    .locator(".absolute.z-30")
    .first()
    .textContent()
    .catch(() => "DROPDOWN_NOT_FOUND");
  const inputVisible = await page
    .locator("input[placeholder='Search clients...']")
    .isVisible()
    .catch(() => false);

  // Count visible client options (buttons inside the dropdown excluding "(Unassigned)" and "+ Add New Client")
  const allDropdownButtons = page.locator(".absolute.z-30 button");
  const buttonCount = await allDropdownButtons.count().catch(() => 0);
  const buttonTexts: string[] = [];
  for (let i = 0; i < buttonCount; i++) {
    const text = await allDropdownButtons
      .nth(i)
      .textContent()
      .catch(() => "");
    buttonTexts.push(text?.trim() ?? "");
  }

  // Type to search
  if (inputVisible) {
    await page.locator("input[placeholder='Search clients...']").fill("a");
    await page.waitForTimeout(500);
  }

  const afterSearchDropdown = await page
    .locator(".absolute.z-30")
    .first()
    .textContent()
    .catch(() => "DROPDOWN_NOT_FOUND");

  // Log everything we captured
  console.log("=== STORE MAPPING DROPDOWN DIAGNOSTIC ===");
  console.log(`Search input visible: ${inputVisible}`);
  console.log(`Dropdown text: ${dropdownText}`);
  console.log(`Dropdown button count: ${buttonCount}`);
  console.log(`Button texts: ${JSON.stringify(buttonTexts)}`);
  console.log(`After typing 'a': ${afterSearchDropdown}`);
  console.log(`Console errors: ${JSON.stringify(consoleErrors)}`);
  console.log(`Network errors: ${JSON.stringify(networkErrors)}`);
  console.log(`Server action logs: ${JSON.stringify(serverActionResults)}`);

  // The assertion we care about: there should be at least one client option beyond "(Unassigned)" and "+ Add New Client"
  const clientOptions = buttonTexts.filter(
    (t) =>
      t &&
      t !== "(Unassigned)" &&
      !t.includes("Add New Client") &&
      !t.includes("Loading") &&
      !t.includes("Failed"),
  );

  console.log(`Client options found: ${JSON.stringify(clientOptions)}`);

  // Soft assertion — report findings even if it fails
  expect(
    clientOptions.length,
    `Expected client options in dropdown but got none.\nAll buttons: ${JSON.stringify(buttonTexts)}\nDropdown text: ${dropdownText}\nConsole errors: ${JSON.stringify(consoleErrors)}\nNetwork errors: ${JSON.stringify(networkErrors)}`,
  ).toBeGreaterThan(0);
});
