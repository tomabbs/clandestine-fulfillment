"use server";

import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import type {
  WarehouseBillingAdjustment,
  WarehouseBillingRule,
  WarehouseBillingRuleOverride,
  WarehouseBillingSnapshot,
  WarehouseFormatCost,
} from "@/lib/shared/types";

export async function getAuthWorkspaceId(): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return "";

  const serviceClient = createServiceRoleClient();
  const { data: userRecord, error: userError } = await serviceClient
    .from("users")
    .select("workspace_id")
    .eq("auth_user_id", authData.user.id)
    .single();

  if (userError || !userRecord) {
    throw new Error("User record not found");
  }

  return userRecord.workspace_id;
}

// === Billing Rules ===

export async function getBillingRules(workspaceId: string) {
  const supabase = await createServerSupabaseClient();

  const [rulesResult, formatCostsResult] = await Promise.all([
    supabase
      .from("warehouse_billing_rules")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("rule_name"),
    supabase
      .from("warehouse_format_costs")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("format_name"),
  ]);

  if (rulesResult.error) throw new Error(rulesResult.error.message);
  if (formatCostsResult.error) throw new Error(formatCostsResult.error.message);

  return {
    rules: rulesResult.data as WarehouseBillingRule[],
    formatCosts: formatCostsResult.data as WarehouseFormatCost[],
  };
}

export async function updateBillingRule(
  ruleId: string,
  data: Partial<Pick<WarehouseBillingRule, "amount" | "description" | "is_active" | "rule_name">>,
) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("warehouse_billing_rules").update(data).eq("id", ruleId);

  if (error) throw new Error(error.message);
}

export async function createBillingRule(data: Omit<WarehouseBillingRule, "id" | "created_at">) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("warehouse_billing_rules").insert({
    ...data,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  });

  if (error) throw new Error(error.message);
}

// === Format Costs ===

export async function getFormatCosts(workspaceId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("warehouse_format_costs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("sort_order")
    .order("format_name");

  if (error) throw new Error(error.message);
  return data as WarehouseFormatCost[];
}

export async function updateFormatCost(
  formatId: string,
  data: Partial<
    Pick<
      WarehouseFormatCost,
      "pick_pack_cost" | "material_cost" | "display_name" | "cost_breakdown" | "sort_order"
    >
  >,
) {
  const supabase = await createServerSupabaseClient();
  const updateData: Record<string, unknown> = {
    ...data,
    updated_at: new Date().toISOString(),
  };
  if (data.pick_pack_cost !== undefined || data.material_cost !== undefined) {
    updateData.cost_breakdown = {
      pick_pack: data.pick_pack_cost,
      material: data.material_cost,
    };
  }
  const { error } = await supabase
    .from("warehouse_format_costs")
    .update(updateData)
    .eq("id", formatId);

  if (error) throw new Error(error.message);
}

export async function createFormatCost(
  data: Omit<WarehouseFormatCost, "id" | "created_at" | "updated_at">,
) {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();
  const { error } = await supabase.from("warehouse_format_costs").insert({
    ...data,
    format_key: data.format_name.toLowerCase().replace(/\s+/g, "_"),
    display_name: data.display_name ?? data.format_name,
    cost_breakdown: { pick_pack: data.pick_pack_cost, material: data.material_cost },
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
  });

  if (error) throw new Error(error.message);
}

// === Billing Snapshots ===

export async function getBillingSnapshots(filters: {
  workspaceId: string;
  orgId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  const supabase = await createServerSupabaseClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("warehouse_billing_snapshots")
    .select("*, organizations!inner(name)", { count: "exact" })
    .eq("workspace_id", filters.workspaceId)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.orgId) {
    query = query.eq("org_id", filters.orgId);
  }
  if (filters.status) {
    query = query.eq("status", filters.status);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  return {
    snapshots: (data ?? []) as (WarehouseBillingSnapshot & {
      organizations: { name: string };
    })[],
    total: count ?? 0,
    page,
    pageSize,
  };
}

export async function getBillingSnapshotDetail(id: string) {
  const supabase = await createServerSupabaseClient();

  const [snapshotResult, adjustmentsResult] = await Promise.all([
    supabase
      .from("warehouse_billing_snapshots")
      .select("*, organizations!inner(name)")
      .eq("id", id)
      .single(),
    supabase
      .from("warehouse_billing_adjustments")
      .select("*")
      .eq("snapshot_id", id)
      .order("created_at", { ascending: false }),
  ]);

  if (snapshotResult.error) throw new Error(snapshotResult.error.message);

  return {
    snapshot: snapshotResult.data as WarehouseBillingSnapshot & {
      organizations: { name: string };
    },
    adjustments: (adjustmentsResult.data ?? []) as WarehouseBillingAdjustment[],
  };
}

// === Adjustments ===

export async function createBillingAdjustment(data: {
  workspace_id: string;
  org_id: string;
  billing_period: string;
  amount: number;
  reason: string;
  snapshot_id?: string;
}) {
  const supabase = await createServerSupabaseClient();

  const { data: user } = await supabase.auth.getUser();

  const { error } = await supabase.from("warehouse_billing_adjustments").insert({
    id: crypto.randomUUID(),
    ...data,
    created_by: user?.user?.id ?? null,
    snapshot_id: data.snapshot_id ?? null,
    created_at: new Date().toISOString(),
  });

  if (error) throw new Error(error.message);
}

// === Client Overrides ===

export async function getClientOverrides(workspaceId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("warehouse_billing_rule_overrides")
    .select("*, organizations!inner(name), warehouse_billing_rules!inner(rule_name, rule_type)")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data as (WarehouseBillingRuleOverride & {
    organizations: { name: string };
    warehouse_billing_rules: { rule_name: string; rule_type: string };
  })[];
}

export async function createClientOverride(data: {
  workspace_id: string;
  org_id: string;
  rule_id: string;
  override_amount: number;
  effective_from: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data: user } = await supabase.auth.getUser();
  const now = new Date().toISOString();

  const { error } = await supabase.from("warehouse_billing_rule_overrides").insert({
    id: crypto.randomUUID(),
    ...data,
    created_by: user?.user?.id ?? null,
    created_at: now,
    updated_at: now,
  });

  if (error) throw new Error(error.message);
}

export async function deleteClientOverride(overrideId: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("warehouse_billing_rule_overrides")
    .delete()
    .eq("id", overrideId);

  if (error) throw new Error(error.message);
}
