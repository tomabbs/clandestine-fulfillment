"use server";

import { createServerSupabaseClient } from "@/lib/server/supabase-server";

export async function getReviewQueueItems(filters?: {
  severity?: string;
  status?: string;
  category?: string;
  assignedTo?: string;
  orgId?: string;
  page?: number;
  pageSize?: number;
}) {
  const supabase = await createServerSupabaseClient();
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("warehouse_review_queue")
    .select("*, organizations(name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filters?.severity) query = query.eq("severity", filters.severity);
  if (filters?.status) query = query.eq("status", filters.status);
  if (filters?.category) query = query.eq("category", filters.category);
  if (filters?.assignedTo) query = query.eq("assigned_to", filters.assignedTo);
  if (filters?.orgId) query = query.eq("org_id", filters.orgId);

  const { data, count } = await query;
  return { items: data ?? [], total: count ?? 0, page, pageSize };
}

export async function assignReviewItem(id: string, staffUserId: string) {
  const supabase = await createServerSupabaseClient();
  await supabase
    .from("warehouse_review_queue")
    .update({ assigned_to: staffUserId, updated_at: new Date().toISOString() })
    .eq("id", id);
  return { success: true };
}

export async function resolveReviewItem(id: string, resolutionNotes: string) {
  const supabase = await createServerSupabaseClient();
  await supabase
    .from("warehouse_review_queue")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      description: resolutionNotes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  return { success: true };
}

export async function suppressReviewItem(id: string, hours: number) {
  const supabase = await createServerSupabaseClient();
  const suppressedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  await supabase
    .from("warehouse_review_queue")
    .update({
      status: "suppressed",
      suppressed_until: suppressedUntil,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  return { success: true };
}

export async function reopenReviewItem(id: string) {
  const supabase = await createServerSupabaseClient();
  await supabase
    .from("warehouse_review_queue")
    .update({
      status: "open",
      resolved_by: null,
      resolved_at: null,
      suppressed_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  return { success: true };
}

export async function bulkAssign(ids: string[], staffUserId: string) {
  const supabase = await createServerSupabaseClient();
  await supabase
    .from("warehouse_review_queue")
    .update({ assigned_to: staffUserId, updated_at: new Date().toISOString() })
    .in("id", ids);
  return { success: true, count: ids.length };
}

export async function bulkResolve(ids: string[], notes: string) {
  const supabase = await createServerSupabaseClient();
  await supabase
    .from("warehouse_review_queue")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      description: notes,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);
  return { success: true, count: ids.length };
}
