"use server";

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// --- Input schemas (Rule #5: Zod for all boundaries) ---

const initiateImportSchema = z.object({
  storagePath: z.string().min(1),
  fileName: z.string().min(1),
});

const getImportHistorySchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
});

// --- Server Actions ---

export async function initiateImport(storagePath: string, fileName: string) {
  const input = initiateImportSchema.parse({ storagePath, fileName });

  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const { data: userData } = await supabase
    .from("users")
    .select("id, workspace_id")
    .eq("auth_user_id", user.id)
    .single();

  if (!userData) throw new Error("User not found");

  const { data: importRecord, error } = await supabase
    .from("warehouse_pirate_ship_imports")
    .insert({
      workspace_id: userData.workspace_id,
      file_name: input.fileName,
      storage_path: input.storagePath,
      status: "pending",
      uploaded_by: userData.id,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create import record: ${error.message}`);

  // Rule #41/#48: Fire Trigger task for heavy processing.
  // Wrapped in try/catch — if enqueue fails, mark the row failed immediately
  // so it does not stay "pending" forever.
  // Note: if the update inside catch also fails (double transient failure),
  // the 30-min stuck-import sensor in sensor-check.ts catches it.
  try {
    await tasks.trigger("pirate-ship-import", {
      importId: importRecord.id,
      workspaceId: userData.workspace_id,
    });
  } catch (triggerErr) {
    await supabase
      .from("warehouse_pirate_ship_imports")
      .update({
        status: "failed",
        errors: [
          {
            phase: "enqueue",
            message: `Failed to start import task: ${String(triggerErr)}`,
            timestamp: new Date().toISOString(),
          },
        ],
        completed_at: new Date().toISOString(),
      })
      .eq("id", importRecord.id);
    throw new Error(`Import saved but could not be queued: ${String(triggerErr)}`);
  }

  return { importId: importRecord.id };
}

export async function getImportHistory(filters?: {
  page?: number;
  pageSize?: number;
  status?: "pending" | "processing" | "completed" | "failed";
}) {
  const input = getImportHistorySchema.parse(filters ?? {});

  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      imports: [],
      total: 0,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  let query = supabase
    .from("warehouse_pirate_ship_imports")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1);

  if (input.status) {
    query = query.eq("status", input.status);
  }

  const { data, count, error } = await query;

  if (error) throw new Error(`Failed to fetch imports: ${error.message}`);

  return {
    imports: data ?? [],
    total: count ?? 0,
    page: input.page,
    pageSize: input.pageSize,
  };
}

export async function getImportDetail(importId: string) {
  const id = z.string().uuid().parse(importId);

  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      import: null,
      unmatchedItems: [],
      matchedShipments: [],
    };
  }

  const { data, error } = await supabase
    .from("warehouse_pirate_ship_imports")
    .select("*")
    .eq("id", id)
    .single();

  if (error) throw new Error(`Failed to fetch import: ${error.message}`);

  // Use ->> (text extraction) not -> (JSONB) for UUID string comparison in PostgREST
  const { data: reviewItems } = await supabase
    .from("warehouse_review_queue")
    .select("*")
    .eq("category", "pirate_ship_unmatched_org")
    .filter("metadata->>import_id", "eq", id);

  const { data: shipments } = await supabase
    .from("warehouse_shipments")
    .select("id, org_id, tracking_number, carrier, ship_date, shipping_cost, status")
    .filter("label_data->>import_id", "eq", id);

  return {
    import: data,
    unmatchedItems: reviewItems ?? [],
    matchedShipments: shipments ?? [],
  };
}
