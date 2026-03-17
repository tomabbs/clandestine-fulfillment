import { describe, expect, it } from "vitest";
import { parseOnboardingState } from "@/lib/shared/onboarding";

describe("clients actions", () => {
  describe("onboarding progress calculation", () => {
    it("calculates 0% for empty state", () => {
      const steps = parseOnboardingState(null);
      const completed = steps.filter((s) => s.completed).length;
      const pct = Math.round((completed / steps.length) * 100);
      expect(pct).toBe(0);
    });

    it("calculates 100% for all steps complete", () => {
      const state = {
        login_complete: true,
        portal_configured: true,
        store_connections_submitted: true,
        sku_mappings_verified: true,
        inbound_contact_confirmed: true,
        billing_contact_confirmed: true,
        first_inventory_sync: true,
        support_email_active: true,
      };
      const steps = parseOnboardingState(state);
      const completed = steps.filter((s) => s.completed).length;
      const pct = Math.round((completed / steps.length) * 100);
      expect(pct).toBe(100);
    });

    it("calculates partial percentage", () => {
      const state = {
        login_complete: true,
        portal_configured: true,
        store_connections_submitted: true,
        sku_mappings_verified: true,
      };
      const steps = parseOnboardingState(state);
      const completed = steps.filter((s) => s.completed).length;
      const pct = Math.round((completed / steps.length) * 100);
      expect(pct).toBe(50);
    });
  });

  describe("onboarding step update", () => {
    it("toggling a step changes its completed state", () => {
      const state: Record<string, unknown> = { login_complete: false };
      state.login_complete = true;
      const steps = parseOnboardingState(state);
      expect(steps.find((s) => s.key === "login_complete")?.completed).toBe(true);
    });

    it("preserves other steps when updating one", () => {
      const state: Record<string, unknown> = {
        login_complete: true,
        portal_configured: false,
      };
      state.portal_configured = true;
      const steps = parseOnboardingState(state);
      expect(steps.find((s) => s.key === "login_complete")?.completed).toBe(true);
      expect(steps.find((s) => s.key === "portal_configured")?.completed).toBe(true);
    });
  });
});
