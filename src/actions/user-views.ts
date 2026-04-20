"use server";

// Phase 8.3 — Saved Filters / Saved Views (per user).
//
// One file backs every list surface in the app — orders cockpit is the first
// consumer (`surface = "orders_cockpit"`); future surfaces (mailorder list,
// shipping log, etc.) reuse the same actions with their own surface key.
//
// view_state JSONB is consumer-defined. The action layer doesn't validate
// the shape — that's the consuming UI's responsibility.
//
// is_default: at most one TRUE per (user_id, surface). Enforced by partial
// unique index in the migration AND by setDefaultView() clearing the prior
// default in a single transaction (well, two updates) before flipping.

import { z } from "zod";
import { requireStaff } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface SavedView {
  id: string;
  user_id: string;
  surface: string;
  name: string;
  view_state: Record<string, unknown>;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

const surfaceSchema = z.string().min(1).max(64);
const viewNameSchema = z.string().min(1).max(80);

export async function listViews(input: { surface: string }): Promise<SavedView[]> {
  const { userId } = await requireStaff();
  const surface = surfaceSchema.parse(input.surface);
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("user_view_prefs")
    .select("*")
    .eq("user_id", userId)
    .eq("surface", surface)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });
  return (data ?? []) as SavedView[];
}

export async function saveView(input: {
  surface: string;
  name: string;
  view_state: Record<string, unknown>;
  is_default?: boolean;
}): Promise<SavedView> {
  const { userId } = await requireStaff();
  const surface = surfaceSchema.parse(input.surface);
  const name = viewNameSchema.parse(input.name);
  const supabase = createServiceRoleClient();

  // If this view should be the default, clear any other default for the same
  // (user, surface) first. Two updates is fine here — the partial unique index
  // would reject the second flip otherwise.
  if (input.is_default) {
    await supabase
      .from("user_view_prefs")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("surface", surface)
      .eq("is_default", true);
  }

  const { data, error } = await supabase
    .from("user_view_prefs")
    .upsert(
      {
        user_id: userId,
        surface,
        name,
        view_state: input.view_state,
        is_default: input.is_default ?? false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,surface,name" },
    )
    .select("*")
    .single();
  if (error || !data) throw new Error(`saveView failed: ${error?.message ?? "unknown"}`);
  return data as SavedView;
}

export async function deleteView(input: { id: string }): Promise<{ ok: true }> {
  const { userId } = await requireStaff();
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("user_view_prefs")
    .delete()
    .eq("id", input.id)
    .eq("user_id", userId);
  if (error) throw new Error(`deleteView failed: ${error.message}`);
  return { ok: true };
}

export async function setDefaultView(input: { id: string; surface: string }): Promise<{ ok: true }> {
  const { userId } = await requireStaff();
  const surface = surfaceSchema.parse(input.surface);
  const supabase = createServiceRoleClient();
  // Clear the existing default first (partial unique index prevents two true values).
  await supabase
    .from("user_view_prefs")
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("surface", surface)
    .eq("is_default", true);
  const { error } = await supabase
    .from("user_view_prefs")
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq("id", input.id)
    .eq("user_id", userId);
  if (error) throw new Error(`setDefaultView failed: ${error.message}`);
  return { ok: true };
}
