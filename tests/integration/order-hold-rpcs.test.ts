import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyOrderFulfillmentHold,
  releaseOrderFulfillmentHold,
} from "@/lib/server/order-hold-rpcs";

/**
 * Integration-level contract tests for Phase 3.B order-hold RPCs.
 *
 * Release gates:
 *   * SKU-AUTO-15 — apply_order_fulfillment_hold writes the state
 *     column + hold_applied event atomically.
 *   * SKU-AUTO-17 — release_order_fulfillment_hold whitelist +
 *     staff_override note requirement.
 *   * SKU-AUTO-21 — commit inserts land in the same transaction as
 *     the hold write (inventory_commitments row visible after the
 *     RPC returns).
 *   * SKU-AUTO-22 — advisory-lock serialization per order (happy
 *     path only; concurrency stress is tested by the wrapper-level
 *     mock tests plus the Phase 1 concurrency probe pattern).
 *   * SKU-AUTO-32 — staff_override note + typed resolution_codes.
 *
 * Gated on `INTEGRATION_TEST_SUPABASE_URL` +
 * `INTEGRATION_TEST_SERVICE_ROLE_KEY` and skipped when missing. Run
 * via `pnpm test:integration` (same pattern as
 * `sku-outcome-transition-concurrency.test.ts`).
 */

const url = process.env.INTEGRATION_TEST_SUPABASE_URL;
const serviceKey = process.env.INTEGRATION_TEST_SERVICE_ROLE_KEY;
const enabled = Boolean(url && serviceKey);
const describeOrSkip = enabled ? describe : describe.skip;

describeOrSkip("order-hold RPCs (Phase 3.B, SKU-AUTO-15/17/21/22/32)", () => {
  if (!enabled) {
    it.skip("integration env vars not set — skipping", () => {});
    return;
  }

  const service = createClient(url as string, serviceKey as string, {
    auth: { persistSession: false },
  });

  let wsId: string;
  let orgId: string;
  let connectionId: string;

  beforeAll(async () => {
    const stamp = Date.now();

    const ws = await service
      .from("workspaces")
      .insert({ name: `hold-rpc-${stamp}`, slug: `hold-rpc-${stamp}` })
      .select("id")
      .single();
    if (ws.error) throw ws.error;
    wsId = ws.data.id;

    const org = await service
      .from("organizations")
      .insert({ workspace_id: wsId, name: "Org", slug: `org-hold-${stamp}` })
      .select("id")
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id;

    const conn = await service
      .from("client_store_connections")
      .insert({
        workspace_id: wsId,
        org_id: orgId,
        platform: "shopify",
        store_url: `https://hold-rpc-${stamp}.myshopify.com`,
        connection_status: "active",
      })
      .select("id")
      .single();
    if (conn.error) throw conn.error;
    connectionId = conn.data.id;
  });

  afterAll(async () => {
    if (wsId) {
      await service.from("workspaces").delete().eq("id", wsId);
    }
  });

  // Helper: insert a fresh warehouse_orders row per test so state is
  // independent.
  async function makeOrder(): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const order = await service
      .from("warehouse_orders")
      .insert({
        workspace_id: wsId,
        org_id: orgId,
        order_number: `TEST-${stamp}`,
        source: "shopify",
      })
      .select("id")
      .single();
    if (order.error) throw order.error;
    return order.data.id as string;
  }

  it("apply → release → state + event timeline matches contract", async () => {
    const orderId = await makeOrder();
    const cycleId = crypto.randomUUID();

    const applied = await applyOrderFulfillmentHold(service, {
      orderId,
      connectionId,
      reason: "unknown_remote_sku",
      cycleId,
      heldLines: [{ line_item_id: "li-1", remote_sku: "UNK-1" }],
      // SKU-AUTO-21: ship a committable line; the RPC must insert it.
      commitLines: [{ sku: "TEST-SKU-COMMIT", qty: 3 }],
      actorKind: "system",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("apply failed");
    expect(applied.commitsInserted).toBe(1);
    expect(applied.idempotent).toBe(false);

    const afterApply = await service
      .from("warehouse_orders")
      .select("fulfillment_hold, fulfillment_hold_cycle_id, fulfillment_hold_reason")
      .eq("id", orderId)
      .single();
    expect(afterApply.error).toBeNull();
    expect(afterApply.data?.fulfillment_hold).toBe("on_hold");
    expect(afterApply.data?.fulfillment_hold_cycle_id).toBe(cycleId);
    expect(afterApply.data?.fulfillment_hold_reason).toBe("unknown_remote_sku");

    const applyEvents = await service
      .from("order_fulfillment_hold_events")
      .select("id, event_type, hold_cycle_id, hold_reason, connection_id")
      .eq("order_id", orderId)
      .eq("event_type", "hold_applied");
    expect(applyEvents.error).toBeNull();
    expect(applyEvents.data ?? []).toHaveLength(1);
    expect(applyEvents.data?.[0]?.hold_cycle_id).toBe(cycleId);
    expect(applyEvents.data?.[0]?.connection_id).toBe(connectionId);

    // SKU-AUTO-21: commitment row visible in same transaction.
    const commits = await service
      .from("inventory_commitments")
      .select("sku, qty, released_at")
      .eq("workspace_id", wsId)
      .eq("source", "order")
      .eq("source_id", orderId);
    expect(commits.error).toBeNull();
    expect(commits.data ?? []).toHaveLength(1);
    expect(commits.data?.[0]?.sku).toBe("TEST-SKU-COMMIT");
    expect(commits.data?.[0]?.qty).toBe(3);
    expect(commits.data?.[0]?.released_at).toBeNull();

    // Release.
    const released = await releaseOrderFulfillmentHold(service, {
      orderId,
      resolutionCode: "alias_learned",
      actorKind: "task",
    });
    expect(released.ok).toBe(true);

    const afterRelease = await service
      .from("warehouse_orders")
      .select("fulfillment_hold, fulfillment_hold_released_at")
      .eq("id", orderId)
      .single();
    expect(afterRelease.data?.fulfillment_hold).toBe("released");
    expect(afterRelease.data?.fulfillment_hold_released_at).not.toBeNull();

    const releaseEvents = await service
      .from("order_fulfillment_hold_events")
      .select("id, event_type, resolution_code, hold_cycle_id")
      .eq("order_id", orderId)
      .eq("event_type", "hold_released");
    expect(releaseEvents.data ?? []).toHaveLength(1);
    expect(releaseEvents.data?.[0]?.resolution_code).toBe("alias_learned");
    expect(releaseEvents.data?.[0]?.hold_cycle_id).toBe(cycleId);
  });

  it("apply is idempotent on the same (order_id, cycle_id)", async () => {
    const orderId = await makeOrder();
    const cycleId = crypto.randomUUID();

    const first = await applyOrderFulfillmentHold(service, {
      orderId,
      connectionId,
      reason: "non_warehouse_match",
      cycleId,
      heldLines: [{ line_item_id: "li-x" }],
      commitLines: [{ sku: "IDEMPOTENT-SKU", qty: 1 }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first apply failed");

    const second = await applyOrderFulfillmentHold(service, {
      orderId,
      connectionId,
      reason: "non_warehouse_match",
      cycleId,
      heldLines: [{ line_item_id: "li-x" }],
      commitLines: [{ sku: "IDEMPOTENT-SKU", qty: 1 }],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("second apply failed");

    expect(second.holdEventId).toBe(first.holdEventId);
    expect(second.commitsInserted).toBe(0);

    const events = await service
      .from("order_fulfillment_hold_events")
      .select("id")
      .eq("order_id", orderId)
      .eq("event_type", "hold_applied");
    expect(events.data ?? []).toHaveLength(1);

    const commits = await service
      .from("inventory_commitments")
      .select("id")
      .eq("source", "order")
      .eq("source_id", orderId)
      .is("released_at", null);
    expect(commits.data ?? []).toHaveLength(1);
  });

  it("apply rejects a cycle_id conflict when already on_hold with a different cycle", async () => {
    const orderId = await makeOrder();
    const firstCycle = crypto.randomUUID();
    const secondCycle = crypto.randomUUID();

    const first = await applyOrderFulfillmentHold(service, {
      orderId,
      connectionId,
      reason: "placeholder_remote_sku",
      cycleId: firstCycle,
      heldLines: [],
    });
    expect(first.ok).toBe(true);

    const second = await applyOrderFulfillmentHold(service, {
      orderId,
      connectionId,
      reason: "placeholder_remote_sku",
      cycleId: secondCycle,
      heldLines: [],
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("cycle_id_conflict");
  });

  it("release rejects staff_override without a note at the RPC layer", async () => {
    const orderId = await makeOrder();
    const cycleId = crypto.randomUUID();
    const applied = await applyOrderFulfillmentHold(service, {
      orderId,
      connectionId,
      reason: "fetch_incomplete_at_match",
      cycleId,
      heldLines: [],
    });
    expect(applied.ok).toBe(true);

    // Bypass the wrapper's pre-check by calling the RPC directly to
    // prove the DB guard works independently.
    const rpcResult = await service.rpc("release_order_fulfillment_hold", {
      p_order_id: orderId,
      p_resolution_code: "staff_override",
      p_note: null,
      p_actor_kind: "user",
      p_actor_id: null,
      p_metadata: {},
    });
    expect(rpcResult.error).not.toBeNull();
    expect(rpcResult.error?.message).toMatch(/staff_override requires a note/);
  });

  it("release is idempotent on already-released orders", async () => {
    const orderId = await makeOrder();
    const cycleId = crypto.randomUUID();

    await applyOrderFulfillmentHold(service, {
      orderId,
      connectionId,
      reason: "unknown_remote_sku",
      cycleId,
      heldLines: [],
    });

    const first = await releaseOrderFulfillmentHold(service, {
      orderId,
      resolutionCode: "order_cancelled",
    });
    expect(first.ok).toBe(true);

    const second = await releaseOrderFulfillmentHold(service, {
      orderId,
      resolutionCode: "order_cancelled",
    });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.holdEventId).toBe(first.holdEventId);
    }

    const releaseEvents = await service
      .from("order_fulfillment_hold_events")
      .select("id")
      .eq("order_id", orderId)
      .eq("event_type", "hold_released");
    expect(releaseEvents.data ?? []).toHaveLength(1);
  });

  it("release rejects invalid resolution_code at the RPC layer", async () => {
    const orderId = await makeOrder();
    const cycleId = crypto.randomUUID();

    await applyOrderFulfillmentHold(service, {
      orderId,
      connectionId,
      reason: "unknown_remote_sku",
      cycleId,
      heldLines: [],
    });

    const rpcResult = await service.rpc("release_order_fulfillment_hold", {
      p_order_id: orderId,
      p_resolution_code: "not_a_real_code",
      p_note: null,
      p_actor_kind: "system",
      p_actor_id: null,
      p_metadata: {},
    });
    expect(rpcResult.error).not.toBeNull();
    expect(rpcResult.error?.message).toMatch(/invalid resolution_code/);
  });
});
