/**
 * HRD-01 — webhook monotonic timestamp guard tests.
 *
 * The guard rejects deliveries whose event timestamp is older than the
 * most-recent one we previously processed for the same
 * (connection_id, topic, entity_id) tuple — protecting against Shopify-style
 * out-of-order retries silently rolling back the latest truth.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { checkMonotonicGuard, extractEventContext } from "@/lib/server/webhook-monotonic-guard";

// --- extractEventContext ---

describe("extractEventContext", () => {
  it("Shopify inventory_levels/update: keys on inventory_item_id", () => {
    const ctx = extractEventContext(
      "shopify",
      "inventory_levels/update",
      {
        inventory_item_id: 1234567890,
        location_id: 99,
        available: 7,
        updated_at: "2026-04-22T10:00:00Z",
      },
      { triggeredAt: "2026-04-22T10:00:01Z" },
    );
    expect(ctx.entityId).toBe("1234567890");
    // Header timestamp wins over payload `updated_at`
    expect(ctx.eventTimestamp).toBe("2026-04-22T10:00:01Z");
  });

  it("Shopify orders/create: keys on order id, falls back to payload updated_at when no header", () => {
    const ctx = extractEventContext("shopify", "orders/create", {
      id: 5001,
      updated_at: "2026-04-22T11:00:00Z",
    });
    expect(ctx.entityId).toBe("5001");
    expect(ctx.eventTimestamp).toBe("2026-04-22T11:00:00Z");
  });

  it("Shopify refunds/create: keys on refund id (id), prefers header timestamp", () => {
    const ctx = extractEventContext(
      "shopify",
      "refunds/create",
      { id: 9001, order_id: 5001, created_at: "2026-04-22T12:00:00Z" },
      { triggeredAt: "2026-04-22T12:00:05Z" },
    );
    expect(ctx.entityId).toBe("9001");
    expect(ctx.eventTimestamp).toBe("2026-04-22T12:00:05Z");
  });

  it("WooCommerce inventory: falls back to date_modified_gmt with appended Z", () => {
    const ctx = extractEventContext("woocommerce", "stock_updated", {
      id: 42,
      date_modified_gmt: "2026-04-22T10:30:00",
    });
    expect(ctx.entityId).toBe("42");
    expect(ctx.eventTimestamp).toBe("2026-04-22T10:30:00Z");
  });

  it("Squarespace order: falls back to modifiedOn", () => {
    const ctx = extractEventContext("squarespace", "order/updated", {
      id: "sq-7",
      modifiedOn: "2026-04-22T13:00:00.000Z",
    });
    expect(ctx.entityId).toBe("sq-7");
    expect(ctx.eventTimestamp).toBe("2026-04-22T13:00:00.000Z");
  });

  it("unknown topic: defaults to payload.id and returns null timestamp when no source available", () => {
    const ctx = extractEventContext("shopify", "weird/topic", { id: 7, foo: "bar" });
    expect(ctx.entityId).toBe("7");
    expect(ctx.eventTimestamp).toBeNull();
  });

  it("returns nulls when payload has no id-bearing field", () => {
    const ctx = extractEventContext("shopify", "orders/create", {});
    expect(ctx.entityId).toBeNull();
    expect(ctx.eventTimestamp).toBeNull();
  });
});

// --- checkMonotonicGuard ---

interface PriorRow {
  id: string;
  last_seen_at: string;
}

function makeSupabase(opts: { prior: PriorRow | null }): SupabaseClient {
  // Build a chainable mock that mirrors the call pattern in checkMonotonicGuard:
  // .from('webhook_events').select(...).eq.eq.eq.eq.neq.not.order.limit.maybeSingle
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.neq = vi.fn(chain);
  builder.not = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.limit = vi.fn(chain);
  builder.maybeSingle = vi.fn(async () => ({ data: opts.prior, error: null }));

  return {
    from: vi.fn(() => builder),
  } as unknown as SupabaseClient;
}

describe("checkMonotonicGuard", () => {
  const baseParams = {
    currentEventId: "evt-current",
    platform: "shopify",
    topic: "inventory_levels/update",
    connectionId: "conn-1",
  };

  it("first delivery for entity (no prior row): reason='first_event_for_entity', not stale", async () => {
    const supabase = makeSupabase({ prior: null });
    const result = await checkMonotonicGuard(supabase, {
      ...baseParams,
      context: { entityId: "inv-1", eventTimestamp: "2026-04-22T10:00:00Z" },
    });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("first_event_for_entity");
    expect(result.priorTimestamp).toBeNull();
  });

  it("newer than prior: reason='newer_than_prior', not stale", async () => {
    const supabase = makeSupabase({
      prior: { id: "evt-old", last_seen_at: "2026-04-22T09:00:00Z" },
    });
    const result = await checkMonotonicGuard(supabase, {
      ...baseParams,
      context: { entityId: "inv-1", eventTimestamp: "2026-04-22T10:00:00Z" },
    });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("newer_than_prior");
    expect(result.priorTimestamp).toBe("2026-04-22T09:00:00Z");
  });

  it("older than prior: reason='stale_dropped', stale=true", async () => {
    const supabase = makeSupabase({
      prior: { id: "evt-newer", last_seen_at: "2026-04-22T11:00:00Z" },
    });
    const result = await checkMonotonicGuard(supabase, {
      ...baseParams,
      context: { entityId: "inv-1", eventTimestamp: "2026-04-22T10:00:00Z" },
    });
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("stale_dropped");
    expect(result.priorTimestamp).toBe("2026-04-22T11:00:00Z");
    expect(result.currentTimestamp).toBe("2026-04-22T10:00:00Z");
  });

  it("equal-to prior: not stale (boundary — strictly less is stale)", async () => {
    const supabase = makeSupabase({
      prior: { id: "evt-old", last_seen_at: "2026-04-22T10:00:00Z" },
    });
    const result = await checkMonotonicGuard(supabase, {
      ...baseParams,
      context: { entityId: "inv-1", eventTimestamp: "2026-04-22T10:00:00Z" },
    });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("newer_than_prior");
  });

  it("missing entity_id: fail-OPEN with reason='missing_entity_id' (does not query DB)", async () => {
    const supabase = makeSupabase({ prior: null });
    const fromSpy = vi.spyOn(supabase, "from");
    const result = await checkMonotonicGuard(supabase, {
      ...baseParams,
      context: { entityId: null, eventTimestamp: "2026-04-22T10:00:00Z" },
    });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("missing_entity_id");
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("missing timestamp: fail-OPEN with reason='missing_timestamp' (does not query DB)", async () => {
    const supabase = makeSupabase({ prior: null });
    const fromSpy = vi.spyOn(supabase, "from");
    const result = await checkMonotonicGuard(supabase, {
      ...baseParams,
      context: { entityId: "inv-1", eventTimestamp: null },
    });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("missing_timestamp");
    expect(fromSpy).not.toHaveBeenCalled();
  });
});
