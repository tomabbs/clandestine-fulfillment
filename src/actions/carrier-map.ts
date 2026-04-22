"use server";

// Phase 8 — Carrier-map admin actions.
//
// Surface for ops to:
//   1. List shipstation_carrier_map rows and their verification state.
//   2. Seed the table from listCarriers() (heuristic name match).
//   3. Flip block_auto_writeback (the verification gate from Phase 4.2)
//      after a real round-trip test passes in production.
//   4. Bump last_verified_at + mapping_confidence='verified' as part of
//      the same flip.
//
// Staff-only (RLS already enforces this on the table).

import { z } from "zod";
import { listCarriers } from "@/lib/clients/shipstation";
import { requireStaff } from "@/lib/server/auth-context";
import { type CarrierMapRow, seedCarrierMapFromShipStation } from "@/lib/server/carrier-map";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface CarrierMapAdminRow extends CarrierMapRow {
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export async function listCarrierMap(): Promise<{
  rows: CarrierMapAdminRow[];
  ssCarrierCodes: string[];
}> {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: rows } = await supabase
    .from("shipstation_carrier_map")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("easypost_carrier", { ascending: true })
    .order("easypost_service", { ascending: true, nullsFirst: true });

  let ssCarrierCodes: string[] = [];
  try {
    const carriers = await listCarriers();
    ssCarrierCodes = carriers.map((c) => c.code);
  } catch {
    // best-effort — admin can still flip rows even if SS is unreachable.
  }

  return {
    rows: (rows ?? []) as CarrierMapAdminRow[],
    ssCarrierCodes,
  };
}

export async function seedCarrierMap(): Promise<{
  inserted: number;
  alreadyPresent: number;
  total_ss_carriers: number;
}> {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();
  return seedCarrierMapFromShipStation(supabase, { workspaceId });
}

const setBlockSchema = z.object({
  rowId: z.string().uuid(),
  blockAutoWriteback: z.boolean(),
  /** When unblocking after a verified round-trip, also stamp confidence + verified_at. */
  markVerified: z.boolean().optional(),
});

export async function setCarrierMapBlock(input: {
  rowId: string;
  blockAutoWriteback: boolean;
  markVerified?: boolean;
}): Promise<{ ok: true }> {
  const { workspaceId } = await requireStaff();
  const parsed = setBlockSchema.parse(input);
  const supabase = createServiceRoleClient();

  const update: Record<string, unknown> = {
    block_auto_writeback: parsed.blockAutoWriteback,
    updated_at: new Date().toISOString(),
  };
  if (parsed.markVerified) {
    update.mapping_confidence = "verified";
    update.last_verified_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("shipstation_carrier_map")
    .update(update)
    .eq("id", parsed.rowId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`setCarrierMapBlock: ${error.message}`);
  return { ok: true };
}

export async function deleteCarrierMapRow(input: { rowId: string }): Promise<{ ok: true }> {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("shipstation_carrier_map")
    .delete()
    .eq("id", input.rowId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`deleteCarrierMapRow: ${error.message}`);
  return { ok: true };
}

const upsertSchema = z.object({
  easypostCarrier: z.string().min(1),
  easypostService: z.string().min(1).nullable(),
  shipstationCarrierCode: z.string().min(1),
  shipstationServiceCode: z.string().min(1).nullable().optional(),
  notes: z.string().nullable().optional(),
});

export async function upsertCarrierMapRow(input: {
  easypostCarrier: string;
  easypostService: string | null;
  shipstationCarrierCode: string;
  shipstationServiceCode?: string | null;
  notes?: string | null;
}): Promise<CarrierMapAdminRow> {
  const { workspaceId } = await requireStaff();
  const parsed = upsertSchema.parse(input);
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("shipstation_carrier_map")
    .upsert(
      {
        workspace_id: workspaceId,
        easypost_carrier: parsed.easypostCarrier,
        easypost_service: parsed.easypostService,
        shipstation_carrier_code: parsed.shipstationCarrierCode,
        shipstation_service_code: parsed.shipstationServiceCode ?? null,
        mapping_confidence: "manual",
        block_auto_writeback: true,
        notes: parsed.notes ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,easypost_carrier,easypost_service" },
    )
    .select("*")
    .single();
  if (error || !data) throw new Error(`upsertCarrierMapRow: ${error?.message ?? "unknown"}`);
  return data as CarrierMapAdminRow;
}
