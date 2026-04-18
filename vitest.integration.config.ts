import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Integration test config — Tier 1 hardening (Part 14.7) item #3.
 *
 * Runs the tests in tests/integration/** ONLY. These tests typically
 * connect to a live (non-prod) Supabase project and clean up after
 * themselves. They are gated on env vars (see each suite); without those
 * vars set, the suites skip rather than fail.
 *
 * Invoke via `pnpm test:integration`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/integration/**/*.test.{ts,tsx}"],
    setupFiles: [],
    testTimeout: 30_000,
  },
});
