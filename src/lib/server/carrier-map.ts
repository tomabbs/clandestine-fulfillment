// Phase 4.2 — Carrier map lookup + seeding helpers.
//
// Lookup with carrier-family fallback (Reviewer 5):
//   1. Try exact (workspace, easypost_carrier, easypost_service).
//   2. Fall back to (workspace, easypost_carrier, NULL) — family wildcard.
//   3. Return null if neither matches → caller blocks writeback for this row.
//
// block_auto_writeback is enforced HERE (the lookup returns null when block
// is true) so every consumer (Phase 4.3 task, future bulk writeback) hits
// the same rule. The "manual override" path is a separate API surface
// where staff explicitly bypass the block per-shipment.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listCarriers } from "@/lib/clients/shipstation";

export type MappingConfidence = "verified" | "inferred" | "manual" | "untested";

export interface CarrierMapRow {
  id: string;
  workspace_id: string;
  easypost_carrier: string;
  easypost_service: string | null;
  shipstation_carrier_code: string;
  shipstation_service_code: string | null;
  mapping_confidence: MappingConfidence;
  last_verified_at: string | null;
  block_auto_writeback: boolean;
}

export interface ResolvedCarrierMapping {
  shipstation_carrier_code: string;
  shipstation_service_code: string | null;
  /** "specific" if the (carrier, service) row matched; "family" if the (carrier, NULL) wildcard fired. */
  matched_via: "specific" | "family";
  mapping_confidence: MappingConfidence;
  row_id: string;
}

export interface ResolveCarrierMappingArgs {
  workspaceId: string;
  easypostCarrier: string;
  easypostService: string | null | undefined;
  /** When TRUE, bypass the block_auto_writeback check (staff explicitly chose "Send anyway"). */
  bypassBlock?: boolean;
}

export type ResolveCarrierMappingResult =
  | { ok: true; mapping: ResolvedCarrierMapping }
  | { ok: false; reason: "no_mapping" | "blocked_by_low_confidence"; details?: string };

/**
 * Phase 4.2 — resolve EP carrier+service to SS carrier_code via carrier_map.
 *
 * Returns ok=false when:
 *   - no row matches (caller surfaces "carrier not mapped — add to admin UI")
 *   - the matching row has block_auto_writeback=true and bypassBlock=false
 *     (caller surfaces "low confidence — confirm with Send Anyway")
 *
 * Exposed for unit testing.
 */
export async function resolveCarrierMapping(
  supabase: SupabaseClient,
  args: ResolveCarrierMappingArgs,
): Promise<ResolveCarrierMappingResult> {
  // Step 1: try exact match (specific service row).
  if (args.easypostService) {
    const { data: specific } = await supabase
      .from("shipstation_carrier_map")
      .select(
        "id, shipstation_carrier_code, shipstation_service_code, mapping_confidence, block_auto_writeback",
      )
      .eq("workspace_id", args.workspaceId)
      .eq("easypost_carrier", args.easypostCarrier)
      .eq("easypost_service", args.easypostService)
      .maybeSingle();

    if (specific) {
      if (specific.block_auto_writeback && !args.bypassBlock) {
        return {
          ok: false,
          reason: "blocked_by_low_confidence",
          details: `mapping for ${args.easypostCarrier}/${args.easypostService} has block_auto_writeback=true (confidence=${specific.mapping_confidence})`,
        };
      }
      return {
        ok: true,
        mapping: {
          shipstation_carrier_code: specific.shipstation_carrier_code,
          shipstation_service_code: specific.shipstation_service_code,
          matched_via: "specific",
          mapping_confidence: specific.mapping_confidence as MappingConfidence,
          row_id: specific.id,
        },
      };
    }
  }

  // Step 2: family wildcard (easypost_service IS NULL).
  const { data: family } = await supabase
    .from("shipstation_carrier_map")
    .select(
      "id, shipstation_carrier_code, shipstation_service_code, mapping_confidence, block_auto_writeback",
    )
    .eq("workspace_id", args.workspaceId)
    .eq("easypost_carrier", args.easypostCarrier)
    .is("easypost_service", null)
    .maybeSingle();

  if (family) {
    if (family.block_auto_writeback && !args.bypassBlock) {
      return {
        ok: false,
        reason: "blocked_by_low_confidence",
        details: `family wildcard for ${args.easypostCarrier} has block_auto_writeback=true (confidence=${family.mapping_confidence})`,
      };
    }
    return {
      ok: true,
      mapping: {
        shipstation_carrier_code: family.shipstation_carrier_code,
        shipstation_service_code: family.shipstation_service_code,
        matched_via: "family",
        mapping_confidence: family.mapping_confidence as MappingConfidence,
        row_id: family.id,
      },
    };
  }

  return {
    ok: false,
    reason: "no_mapping",
    details: `no carrier_map row for workspace=${args.workspaceId}, carrier=${args.easypostCarrier}, service=${args.easypostService ?? "(any)"}`,
  };
}

/**
 * Phase 4.2 — when a family-wildcard fallback fires for a previously-unseen
 * specific service, log it so ops can decide whether to add a specific override.
 *
 * Emits a `sensor_readings` row + a `warehouse_review_queue` item. Both are
 * fire-and-forget (logged but never throw).
 */
export async function logUnmappedServiceUsedFamilyFallback(
  supabase: SupabaseClient,
  args: {
    workspaceId: string;
    easypostCarrier: string;
    easypostService: string | null;
    fallbackShipstationCarrierCode: string;
    warehouseShipmentId: string;
  },
): Promise<void> {
  try {
    await supabase.from("sensor_readings").insert({
      workspace_id: args.workspaceId,
      sensor_name: "easypost.unmapped_service_used",
      status: "warning",
      message: `Family wildcard used for ${args.easypostCarrier}/${args.easypostService ?? "(unknown)"} → ${args.fallbackShipstationCarrierCode}`,
      value: {
        easypost_carrier: args.easypostCarrier,
        easypost_service: args.easypostService,
        ss_carrier_code: args.fallbackShipstationCarrierCode,
        warehouse_shipment_id: args.warehouseShipmentId,
      },
    });
  } catch {
    // best-effort; don't block writeback on telemetry failures.
  }

  if (args.easypostService) {
    const groupKey = `unmapped_service:${args.workspaceId}:${args.easypostCarrier}:${args.easypostService}`;
    try {
      await supabase
        .from("warehouse_review_queue")
        .upsert(
          {
            workspace_id: args.workspaceId,
            category: "carrier_mapping",
            severity: "low",
            title: `New EP service "${args.easypostService}" used family wildcard`,
            description: `Carrier ${args.easypostCarrier}, service "${args.easypostService}" routed to ${args.fallbackShipstationCarrierCode} via the family wildcard. Add a specific row in shipstation_carrier_map if this service needs a different SS code.`,
            metadata: {
              easypost_carrier: args.easypostCarrier,
              easypost_service: args.easypostService,
              ss_carrier_code: args.fallbackShipstationCarrierCode,
            },
            status: "open",
            group_key: groupKey,
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: true },
        );
    } catch {
      // best-effort.
    }
  }
}

// ─── Seed helper ─────────────────────────────────────────────────────────────

/**
 * Phase 4.2 — seed shipstation_carrier_map from the v1 GET /carriers response.
 *
 * Heuristically infers (easypost_carrier → SS carrier_code) by name overlap.
 * All seeded rows are written with mapping_confidence='inferred' and
 * block_auto_writeback=true — ops MUST verify per (carrier, service) family
 * before any writeback happens.
 *
 * Idempotent — uses upsert on the (workspace, carrier, service IS NULL)
 * uniqueness path (family wildcard rows only at seed time).
 */
export async function seedCarrierMapFromShipStation(
  supabase: SupabaseClient,
  args: { workspaceId: string },
): Promise<{ inserted: number; alreadyPresent: number; total_ss_carriers: number }> {
  const carriers = await listCarriers({ force: true });
  let inserted = 0;
  let alreadyPresent = 0;

  for (const c of carriers) {
    // Heuristic mapping: strip non-alphanumerics, lowercase, then map to the
    // most likely EP carrier name. Matches the empirical results in
    // scripts/shipstation-precheck.ts.
    const epName = inferEasyPostCarrierName(c.code, c.name);
    if (!epName) continue;

    const { data: existing } = await supabase
      .from("shipstation_carrier_map")
      .select("id")
      .eq("workspace_id", args.workspaceId)
      .eq("easypost_carrier", epName)
      .is("easypost_service", null)
      .maybeSingle();

    if (existing) {
      alreadyPresent++;
      continue;
    }

    const { error } = await supabase.from("shipstation_carrier_map").insert({
      workspace_id: args.workspaceId,
      easypost_carrier: epName,
      easypost_service: null,
      shipstation_carrier_code: c.code,
      shipstation_service_code: null,
      mapping_confidence: "inferred",
      block_auto_writeback: true,
      notes: `Seeded from listCarriers (${c.name}). Verify before flipping block_auto_writeback.`,
    });
    if (!error) inserted++;
  }

  return { inserted, alreadyPresent, total_ss_carriers: carriers.length };
}

/**
 * Best-effort heuristic: SS carrier code → EP carrier name. Returns null when
 * we have no confident guess. Operators can manually add rows for unknowns.
 *
 * Examples (from operator's account, 2026-04-19):
 *   stamps_com           → USPS
 *   ups_walleted         → UPS
 *   fedex_walleted       → FedExDefault
 *   dhl_express_worldwide → DHLExpress
 *   globalpost           → null   (Asendia is a separate EP carrier; needs explicit row)
 *   seko_ltl_walleted    → null
 */
function inferEasyPostCarrierName(ssCode: string, ssName: string): string | null {
  const s = `${ssCode} ${ssName}`.toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("stampscom") || s.includes("usps")) return "USPS";
  if (s.includes("ups")) return "UPS";
  if (s.includes("fedex")) return "FedExDefault";
  if (s.includes("dhlexpress")) return "DHLExpress";
  if (s.includes("dhlecommerce")) return "DHLeCommerce";
  if (s.includes("canadapost")) return "CanadaPost";
  if (s.includes("asendia")) return "AsendiaUSA";
  return null;
}

/** Stable hash for telemetry — not used for matching. Exposed for tests. */
export function carrierMapKey(args: { carrier: string; service: string | null }): string {
  const canonical = `${args.carrier.toLowerCase()}|${(args.service ?? "*").toLowerCase()}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
