export interface OnboardingStep {
  key: string;
  label: string;
  completed: boolean;
  guidance: string;
}

const ONBOARDING_STEPS: Array<{ key: string; label: string; guidance: string }> = [
  { key: "login_complete", label: "Login complete", guidance: "You're here! This step is done." },
  {
    key: "portal_configured",
    label: "Portal features configured",
    guidance: "Your warehouse team will set up your portal features.",
  },
  {
    key: "store_connections_submitted",
    label: "Store connections submitted",
    guidance: "Go to Settings → Store Connections to submit your store API credentials.",
  },
  {
    key: "sku_mappings_verified",
    label: "SKU mappings verified",
    guidance: "Your warehouse team will verify that your store SKUs are mapped correctly.",
  },
  {
    key: "inbound_contact_confirmed",
    label: "Inbound contact confirmed",
    guidance: "Confirm your primary contact for receiving inbound shipments.",
  },
  {
    key: "billing_contact_confirmed",
    label: "Billing contact confirmed",
    guidance: "Confirm your billing contact email for monthly invoices.",
  },
  {
    key: "first_inventory_sync",
    label: "First inventory sync complete",
    guidance: "Your first inventory sync will happen automatically once stores are connected.",
  },
  {
    key: "support_email_active",
    label: "Support email active",
    guidance: "Your support email will be activated by the warehouse team.",
  },
];

export function parseOnboardingState(state: Record<string, unknown> | null): OnboardingStep[] {
  return ONBOARDING_STEPS.map((step) => ({
    ...step,
    completed: state?.[step.key] === true,
  }));
}
