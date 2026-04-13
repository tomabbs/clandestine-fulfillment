import type { SupabaseClient } from "@supabase/supabase-js";

export interface EffectiveRate {
  amount: number;
  source: "override" | "default";
  ruleName: string;
}

/**
 * Two-tier rate lookup: org-specific override → workspace default.
 *
 * Checks warehouse_billing_rule_overrides for an org-specific amount first
 * (by rule_id FK + effective_from date), then falls back to the workspace-default
 * rule from warehouse_billing_rules.
 *
 * @param effectiveDate - The billing period start date (YYYY-MM-DD) for
 *   effective_from comparison.
 */
export async function getEffectiveRate(
  supabase: SupabaseClient,
  workspaceId: string,
  orgId: string,
  ruleType: string,
  effectiveDate: string,
): Promise<EffectiveRate | null> {
  const { data: defaultRule } = await supabase
    .from("warehouse_billing_rules")
    .select("id, amount, rule_name")
    .eq("workspace_id", workspaceId)
    .eq("rule_type", ruleType)
    .eq("is_active", true)
    .lte("effective_from", effectiveDate)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!defaultRule) return null;

  const { data: override } = await supabase
    .from("warehouse_billing_rule_overrides")
    .select("override_amount")
    .eq("workspace_id", workspaceId)
    .eq("org_id", orgId)
    .eq("rule_id", defaultRule.id)
    .lte("effective_from", effectiveDate)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (override) {
    return {
      amount: Number(override.override_amount),
      source: "override",
      ruleName: defaultRule.rule_name,
    };
  }

  return {
    amount: Number(defaultRule.amount),
    source: "default",
    ruleName: defaultRule.rule_name,
  };
}
