import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Ensure Playwright test process gets the same env vars as Next dev/build.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env.development.local", override: true, quiet: true });

const e2ePort = process.env.E2E_PORT ?? "3000";
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "html",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: e2eBaseUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm dev --port ${e2ePort}`,
    url: e2eBaseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
