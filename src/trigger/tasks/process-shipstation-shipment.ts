/**
 * SHIP_NOTIFY processor (Phase 2, plan §7.1.4).
 *
 * Triggered by `/api/webhooks/shipstation` after dedup + HMAC verify.
 * Walks every shipment in the resource URL and decrements inventory via
 * the canonical write path `recordInventoryChange()`. Bandcamp / client
 * store fanout happens automatically via the in-process fanout step
 * inside `recordInventoryChange` — we do NOT call any external API
 * directly here (Rule #48 / plan §1.4.1 "one write contract").
 *
 * Decisions encoded (per plan §7.1.4 reviewer notes):
 *   - Voided shipments are skipped, not processed.
 *   - Unresolved org BLOCKS the whole shipment (no silent inventory
 *     mutation against an unknown workspace) and writes a review queue
 *     item with severity `high`.
 *   - Unknown SKU does NOT block the rest of the shipment — per-line
 *     failure isolation. Review queue captures details with severity
 *     `medium`.
 *   - Idempotency key shape: `ssv1:shipment:{shipmentId}:{sku}`. A
 *     re-fired SHIP_NOTIFY for the same line item collides on the
 *     `warehouse_inventory_activity` (sku, correlation_id) UNIQUE
 *     constraint via `record_inventory_change_txn` and is dropped
 *     idempotently inside the RPC. The Redis SETNX guard inside
 *     `recordInventoryChange()` provides the same protection on the
 *     Redis side (Rule #47).
 */

import { logger, task, tasks } from "@trigger.dev/sdk";
import { fetchShipmentsByResourceUrl, type ShipStationShipment } from "@/lib/clients/shipstation";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { matchShipmentOrg } from "@/trigger/lib/match-shipment-org";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

interface ProcessShipmentPayload {
  webhookEventId?: string;
  resource_url: string;
}

interface VariantLookupResult {
  workspaceId: string;
  sku: string;
  variantId: string;
  resolvedFromAlias: boolean;
}

export const processShipstationShipmentTask = task({
  id: "process-shipstation-shipment",
  queue: shipstationQueue,
  maxDuration: 120,
  run: async (payload: ProcessShipmentPayload) => {
    const supabase = createServiceRoleClient();

    let shipments: ShipStationShipment[];
    try {
      shipments = await fetchShipmentsByResourceUrl(payload.resource_url);
    } catch (err) {
      logger.error("SHIP_NOTIFY shipment fetch failed", {
        error: String(err),
        resource_url: payload.resource_url,
      });
      await markWebhookEvent(supabase, payload.webhookEventId, "fetch_failed");
      throw err;
    }

    if (shipments.length === 0) {
      logger.warn("SHIP_NOTIFY resolved to zero shipments", {
        resource_url: payload.resource_url,
      });
      await markWebhookEvent(supabase, payload.webhookEventId, "no_shipments");
      return { processed_shipments: 0, results: [] };
    }

    const { data: workspace } = await supabase.from("workspaces").select("id").limit(1).single();
    if (!workspace) {
      throw new Error("No workspace found — cannot process SHIP_NOTIFY");
    }
    const workspaceId = workspace.id as string;

    const results: Array<{
      shipmentId: number;
      status: "ok" | "voided" | "unresolved_org" | "partial";
      lines?: Array<{ sku: string; status: "ok" | "unknown_sku" | "error" }>;
    }> = [];

    for (const shipment of shipments) {
      const shipmentResult = await processOneShipment(supabase, shipment, workspaceId);
      results.push(shipmentResult);
    }

    await markWebhookEvent(supabase, payload.webhookEventId, "processed", { results });

    return { processed_shipments: shipments.length, results };
  },
});

export async function processOneShipment(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: ShipStationShipment,
  workspaceId: string,
): Promise<{
  shipmentId: number;
  status: "ok" | "voided" | "unresolved_org" | "partial";
  lines?: Array<{ sku: string; status: "ok" | "unknown_sku" | "error" }>;
}> {
  const shipmentId = shipment.shipmentId;

  if (shipment.voided) {
    logger.info("Skipping voided SHIP_NOTIFY shipment", { shipmentId });
    return { shipmentId, status: "voided" };
  }

  const items = shipment.shipmentItems ?? [];
  const itemSkus = items.map((i) => i.sku).filter((s): s is string => Boolean(s));
  const storeId = shipment.advancedOptions?.storeId ?? shipment.storeId ?? null;

  const orgMatch = await matchShipmentOrg(supabase, storeId, itemSkus);
  if (!orgMatch) {
    logger.warn("SHIP_NOTIFY org unresolvable", { shipmentId, storeId, itemSkus });
    await supabase.from("warehouse_review_queue").upsert(
      {
        workspace_id: workspaceId,
        category: "shipment_org_match",
        severity: "high",
        title: `SHIP_NOTIFY org unresolvable: ${shipment.trackingNumber ?? shipmentId}`,
        description:
          `SHIP_NOTIFY shipment ${shipmentId} from store ${storeId ?? "unknown"} ` +
          `could not be matched to an org. No inventory writes performed. ` +
          `Resolve via store mapping (Channels page) or contact warehouse staff.`,
        metadata: {
          shipstation_shipment_id: String(shipmentId),
          store_id: storeId,
          tracking_number: shipment.trackingNumber,
          item_skus: itemSkus,
          source: "ship_notify",
        },
        status: "open",
        group_key: `ship_notify_org:${shipmentId}`,
        occurrence_count: 1,
      },
      { onConflict: "group_key", ignoreDuplicates: false },
    );
    return { shipmentId, status: "unresolved_org" };
  }

  const lines: Array<{ sku: string; status: "ok" | "unknown_sku" | "error" }> = [];

  for (const item of items) {
    const itemSku = item.sku;
    if (!itemSku) {
      lines.push({ sku: "", status: "unknown_sku" });
      continue;
    }
    const qty = item.quantity ?? 0;
    if (qty <= 0) {
      lines.push({ sku: itemSku, status: "ok" });
      continue;
    }

    const variant = await findVariantBySkuOrAlias(supabase, itemSku, orgMatch.orgId);
    if (!variant) {
      logger.warn("SHIP_NOTIFY unknown SKU", { shipmentId, sku: itemSku });
      await supabase.from("warehouse_review_queue").upsert(
        {
          workspace_id: workspaceId,
          org_id: orgMatch.orgId,
          category: "shipment_unknown_sku",
          severity: "medium",
          title: `Unknown SKU in SHIP_NOTIFY: ${itemSku}`,
          description:
            `SHIP_NOTIFY shipment ${shipmentId} contained SKU "${itemSku}" with quantity ${qty} ` +
            `that could not be resolved to a warehouse_product_variants row for org ${orgMatch.orgId}. ` +
            `Inventory was NOT decremented. Other line items in this shipment processed independently.`,
          metadata: {
            shipstation_shipment_id: String(shipmentId),
            tracking_number: shipment.trackingNumber,
            sku: itemSku,
            quantity: qty,
            line_item_key: item.lineItemKey ?? null,
            source: "ship_notify",
          },
          status: "open",
          group_key: `ship_notify_unknown_sku:${shipmentId}:${itemSku}`,
          occurrence_count: 1,
        },
        { onConflict: "group_key", ignoreDuplicates: false },
      );
      lines.push({ sku: itemSku, status: "unknown_sku" });
      continue;
    }

    try {
      await recordInventoryChange({
        workspaceId: variant.workspaceId,
        sku: variant.sku,
        delta: -qty,
        source: "shipstation",
        correlationId: `ssv1:shipment:${shipmentId}:${variant.sku}`,
        metadata: {
          shipment_id: String(shipmentId),
          order_number: shipment.orderNumber ?? null,
          line_item_key: item.lineItemKey ?? null,
          tracking_number: shipment.trackingNumber ?? null,
          source_subtype: "ship_notify",
          original_sku: itemSku,
          resolved_from_alias: variant.resolvedFromAlias,
        },
      });
      lines.push({ sku: variant.sku, status: "ok" });

      // Phase 4 — bidirectional bridge: enqueue per-SKU Bandcamp focused
      // push gated through external_sync_events ledger keyed
      // `ship:{shipmentId}:{sku}`. Pinned to bandcampQueue so OAuth stays
      // serialized (Rule #9). fanout-guard applies the `bandcamp` kill
      // switch + workspace rollout bucket; push_mode / bundle / distro
      // gates live inside the focused-push task itself. Cron
      // `bandcamp-inventory-push` (every 5 min) is the safety net if
      // enqueue fails or the focused task short-circuits.
      try {
        await tasks.trigger("bandcamp-push-on-sku", {
          workspaceId: variant.workspaceId,
          sku: variant.sku,
          correlationId: `ship:${shipmentId}:${variant.sku}`,
          reason: "shipstation_ship_notify",
          metadata: {
            shipment_id: String(shipmentId),
            order_number: shipment.orderNumber ?? null,
            line_item_key: item.lineItemKey ?? null,
            tracking_number: shipment.trackingNumber ?? null,
            original_sku: itemSku,
          },
        });
      } catch (enqueueErr) {
        // Non-critical: cron `bandcamp-inventory-push` covers within 5 min.
        logger.warn("SHIP_NOTIFY bandcamp-push-on-sku enqueue failed", {
          shipmentId,
          sku: variant.sku,
          error: String(enqueueErr),
        });
      }
    } catch (err) {
      logger.error("SHIP_NOTIFY recordInventoryChange failed", {
        shipmentId,
        sku: variant.sku,
        error: String(err),
      });
      lines.push({ sku: variant.sku, status: "error" });
    }
  }

  const hasFailure = lines.some((l) => l.status !== "ok");
  return {
    shipmentId,
    status: hasFailure ? "partial" : "ok",
    lines,
  };
}

/**
 * Resolve a SHIP_NOTIFY line-item SKU to a warehouse_product_variants row.
 *
 * Lookup order:
 *   1. Direct SKU match scoped to the matched org (or distro `org_id IS NULL`).
 *   2. `client_store_sku_mappings.remote_sku` → `variant_id` (handles the
 *      case where ShipStation passes the client-store alias SKU, not the
 *      master warehouse SKU — the standard Phase 0.5 rectify pattern).
 *   3. `sku_remap_history` (`from_sku → to_sku`, status=`success`) — handles
 *      DB-side renames where the legacy SKU is still in flight.
 */
export async function findVariantBySkuOrAlias(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sku: string,
  orgId: string,
): Promise<VariantLookupResult | null> {
  const directHit = await lookupVariantBySku(supabase, sku, orgId);
  if (directHit) {
    return { ...directHit, resolvedFromAlias: false };
  }

  // Tier 2: cross-store alias mapping via client_store_sku_mappings.
  // remote_sku is the SKU as the client store / ShipStation knows it.
  const { data: mapping } = await supabase
    .from("client_store_sku_mappings")
    .select(
      "variant_id, warehouse_product_variants!inner(id, sku, workspace_id, warehouse_products!inner(org_id))",
    )
    .eq("remote_sku", sku)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (mapping) {
    const variant = (
      mapping as unknown as {
        warehouse_product_variants?: {
          id: string;
          sku: string;
          workspace_id: string;
          warehouse_products?: { org_id: string | null };
        };
      }
    ).warehouse_product_variants;
    if (variant) {
      const productOrg = variant.warehouse_products?.org_id;
      if (productOrg === orgId || productOrg === null) {
        return {
          workspaceId: variant.workspace_id,
          sku: variant.sku,
          variantId: variant.id,
          resolvedFromAlias: true,
        };
      }
    }
  }

  // Tier 3: sku_remap_history (DB-side rename audit log).
  const { data: remap } = await supabase
    .from("sku_remap_history")
    .select("to_sku")
    .eq("from_sku", sku)
    .eq("status", "success")
    .order("changed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (remap?.to_sku && remap.to_sku !== sku) {
    const indirect = await lookupVariantBySku(supabase, remap.to_sku, orgId);
    if (indirect) {
      return { ...indirect, resolvedFromAlias: true };
    }
  }

  return null;
}

async function lookupVariantBySku(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sku: string,
  orgId: string,
): Promise<{ workspaceId: string; sku: string; variantId: string } | null> {
  const { data } = await supabase
    .from("warehouse_product_variants")
    .select("id, sku, workspace_id, warehouse_products!inner(org_id)")
    .eq("sku", sku)
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  const productOrg = (data as unknown as { warehouse_products?: { org_id: string | null } })
    .warehouse_products?.org_id;
  if (productOrg !== orgId && productOrg !== null) return null;

  return {
    workspaceId: (data as { workspace_id: string }).workspace_id,
    sku: (data as { sku: string }).sku,
    variantId: (data as { id: string }).id,
  };
}

async function markWebhookEvent(
  supabase: ReturnType<typeof createServiceRoleClient>,
  webhookEventId: string | undefined,
  status: string,
  extraMetadata?: Record<string, unknown>,
): Promise<void> {
  if (!webhookEventId) return;
  const update: Record<string, unknown> = {
    status,
    processed_at: new Date().toISOString(),
  };
  if (extraMetadata) {
    // Read existing metadata first so we don't clobber the resource_url
    // recorded by the route handler.
    const { data: existing } = await supabase
      .from("webhook_events")
      .select("metadata")
      .eq("id", webhookEventId)
      .single();
    update.metadata = {
      ...((existing?.metadata as Record<string, unknown> | null) ?? {}),
      ...extraMetadata,
    };
  }
  await supabase.from("webhook_events").update(update).eq("id", webhookEventId);
}
