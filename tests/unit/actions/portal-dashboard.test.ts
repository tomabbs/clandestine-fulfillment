import { describe, expect, it } from "vitest";
import { parseOnboardingState } from "@/lib/shared/onboarding";

describe("parseOnboardingState (Rule #56)", () => {
  it("returns all steps with completed=false for null state", () => {
    const steps = parseOnboardingState(null);
    expect(steps.length).toBe(8);
    expect(steps.every((s) => s.completed === false)).toBe(true);
  });

  it("returns all steps with completed=false for empty state", () => {
    const steps = parseOnboardingState({});
    expect(steps.every((s) => s.completed === false)).toBe(true);
  });

  it("marks completed steps correctly", () => {
    const state = {
      login_complete: true,
      portal_configured: true,
      store_connections_submitted: false,
    };
    const steps = parseOnboardingState(state);

    const login = steps.find((s) => s.key === "login_complete");
    expect(login?.completed).toBe(true);

    const portal = steps.find((s) => s.key === "portal_configured");
    expect(portal?.completed).toBe(true);

    const stores = steps.find((s) => s.key === "store_connections_submitted");
    expect(stores?.completed).toBe(false);
  });

  it("includes guidance text for incomplete steps", () => {
    const steps = parseOnboardingState(null);
    for (const step of steps) {
      expect(step.guidance.length).toBeGreaterThan(0);
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it("handles all 8 expected steps", () => {
    const steps = parseOnboardingState(null);
    const keys = steps.map((s) => s.key);
    expect(keys).toContain("login_complete");
    expect(keys).toContain("portal_configured");
    expect(keys).toContain("store_connections_submitted");
    expect(keys).toContain("sku_mappings_verified");
    expect(keys).toContain("inbound_contact_confirmed");
    expect(keys).toContain("billing_contact_confirmed");
    expect(keys).toContain("first_inventory_sync");
    expect(keys).toContain("support_email_active");
  });

  it("all complete when full state provided", () => {
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
    expect(steps.every((s) => s.completed)).toBe(true);
  });
});
