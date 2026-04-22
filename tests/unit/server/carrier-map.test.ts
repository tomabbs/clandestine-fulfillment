// Phase 4.2 — carrier-map resolver tests.
//
// Verifies the carrier-family fallback rules (Reviewer 5):
//   1. Exact (carrier, service) match wins.
//   2. (carrier, NULL) family wildcard fires when no exact match.
//   3. block_auto_writeback=true returns ok=false unless bypassBlock=true.
//   4. Missing mapping returns ok=false with reason='no_mapping'.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { type CarrierMapRow, carrierMapKey, resolveCarrierMapping } from "@/lib/server/carrier-map";

function makeMockClient(rows: CarrierMapRow[]): SupabaseClient {
  return {
    from(_table: string) {
      const _eqs: Array<[string, unknown]> = [];
      let _isNull = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          _eqs.push([col, val]);
          return builder;
        },
        is: (col: string, val: unknown) => {
          if (col === "easypost_service" && val === null) _isNull = true;
          return builder;
        },
        async maybeSingle() {
          const matches = rows.filter((r) =>
            _eqs.every(([col, val]) => (r as unknown as Record<string, unknown>)[col] === val),
          );
          const filtered = _isNull ? matches.filter((r) => r.easypost_service === null) : matches;
          return { data: filtered[0] ?? null, error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const baseRow = (over: Partial<CarrierMapRow>): CarrierMapRow => ({
  id: "row_1",
  workspace_id: "ws_1",
  easypost_carrier: "USPS",
  easypost_service: null,
  shipstation_carrier_code: "stamps_com",
  shipstation_service_code: null,
  mapping_confidence: "verified",
  last_verified_at: null,
  block_auto_writeback: false,
  ...over,
});

describe("resolveCarrierMapping (Phase 4.2)", () => {
  it("returns no_mapping when no row matches", async () => {
    const sb = makeMockClient([]);
    const r = await resolveCarrierMapping(sb, {
      workspaceId: "ws_1",
      easypostCarrier: "USPS",
      easypostService: "Priority",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_mapping");
  });

  it("matches an exact (carrier, service) row over the family wildcard", async () => {
    const sb = makeMockClient([
      baseRow({
        id: "specific",
        easypost_service: "Priority",
        shipstation_carrier_code: "stamps_com",
        shipstation_service_code: "usps_priority_mail",
        mapping_confidence: "verified",
        block_auto_writeback: false,
      }),
      baseRow({ id: "family", easypost_service: null, mapping_confidence: "verified" }),
    ]);
    const r = await resolveCarrierMapping(sb, {
      workspaceId: "ws_1",
      easypostCarrier: "USPS",
      easypostService: "Priority",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mapping.matched_via).toBe("specific");
      expect(r.mapping.shipstation_service_code).toBe("usps_priority_mail");
      expect(r.mapping.row_id).toBe("specific");
    }
  });

  it("falls back to the family wildcard when no specific row exists", async () => {
    const sb = makeMockClient([
      baseRow({
        id: "family",
        easypost_service: null,
        shipstation_carrier_code: "stamps_com",
        mapping_confidence: "verified",
        block_auto_writeback: false,
      }),
    ]);
    const r = await resolveCarrierMapping(sb, {
      workspaceId: "ws_1",
      easypostCarrier: "USPS",
      easypostService: "PriorityMailExpressInternational",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mapping.matched_via).toBe("family");
      expect(r.mapping.shipstation_carrier_code).toBe("stamps_com");
    }
  });

  it("blocks when block_auto_writeback=true on the matched row", async () => {
    const sb = makeMockClient([
      baseRow({
        easypost_service: "Priority",
        mapping_confidence: "inferred",
        block_auto_writeback: true,
      }),
    ]);
    const r = await resolveCarrierMapping(sb, {
      workspaceId: "ws_1",
      easypostCarrier: "USPS",
      easypostService: "Priority",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_by_low_confidence");
  });

  it("blocks the family wildcard when block_auto_writeback=true (Asendia default)", async () => {
    const sb = makeMockClient([
      baseRow({
        easypost_carrier: "AsendiaUSA",
        easypost_service: null,
        shipstation_carrier_code: "globalpost",
        mapping_confidence: "untested",
        block_auto_writeback: true,
      }),
    ]);
    const r = await resolveCarrierMapping(sb, {
      workspaceId: "ws_1",
      easypostCarrier: "AsendiaUSA",
      easypostService: "Priority Tracked",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_by_low_confidence");
  });

  it("bypassBlock=true returns ok=true even when block_auto_writeback=true (manual override)", async () => {
    const sb = makeMockClient([
      baseRow({
        easypost_service: "Priority",
        mapping_confidence: "inferred",
        block_auto_writeback: true,
      }),
    ]);
    const r = await resolveCarrierMapping(sb, {
      workspaceId: "ws_1",
      easypostCarrier: "USPS",
      easypostService: "Priority",
      bypassBlock: true,
    });
    expect(r.ok).toBe(true);
  });

  it("treats the family wildcard correctly when easypostService is null/undefined on input", async () => {
    const sb = makeMockClient([
      baseRow({
        easypost_service: null,
        mapping_confidence: "verified",
        block_auto_writeback: false,
      }),
    ]);
    const r = await resolveCarrierMapping(sb, {
      workspaceId: "ws_1",
      easypostCarrier: "USPS",
      easypostService: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mapping.matched_via).toBe("family");
  });
});

describe("carrierMapKey (Phase 4.2)", () => {
  it("normalizes case + null service for stable hashing", () => {
    const k1 = carrierMapKey({ carrier: "USPS", service: "Priority" });
    const k2 = carrierMapKey({ carrier: "usps", service: "priority" });
    expect(k1).toBe(k2);
  });

  it("produces a different key for null vs explicit service", () => {
    const k1 = carrierMapKey({ carrier: "USPS", service: null });
    const k2 = carrierMapKey({ carrier: "USPS", service: "Priority" });
    expect(k1).not.toBe(k2);
  });
});
