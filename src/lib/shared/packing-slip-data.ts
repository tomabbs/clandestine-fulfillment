// Phase 3.4 — Shared packing-slip data shape.
//
// One source of truth for what the packing slip needs from the database. The
// per-order route in Phase 3.4 reads via fetchPackingSlipData(); Phase 9 bulk
// print reuses the same shape.
//
// Phase 11.1 — Bandcamp enrichment: when the SS order resolves to a BC
// payment_id (via customField1 matcher), we join bandcamp_sales for
// payment-level fields (buyer_note, ship_notes, additional_fan_contribution,
// payment_state, paypal_transaction_id) and item-level enrichment (artist
// + album_title + bandcamp_image_url) per SKU. Missing payment_id → no
// enrichment, just the SS-sourced fields.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parsePaymentIdFromCustomField } from "@/lib/shared/bandcamp-reconcile-helpers";

export interface PackingSlipAddress {
  name: string | null;
  company: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface PackingSlipLineItem {
  sku: string | null;
  name: string | null;
  quantity: number;
  unit_price: number | null;
  /** Per-line customs override (Phase 0.5.4 column on warehouse_shipment_items).
   *  Available on shipments that already exist; not on orders pre-purchase. */
  customs_description?: string | null;
  /** Phase 11.1 — BC enrichment per SKU. */
  artist?: string | null;
  album_title?: string | null;
  image_url?: string | null;
}

export interface PackingSlipData {
  /** shipstation_orders.id (uuid). */
  shipstation_order_id_internal: string;
  /** ShipStation's bigint orderId (for SS deep links). */
  shipstation_order_id: number;
  order_number: string;
  order_date: string | null;
  customer_name: string | null;
  customer_email: string | null;
  ship_to: PackingSlipAddress;
  org_name: string | null;
  org_id: string | null;
  items: PackingSlipLineItem[];
  /** Phase 11.1 — payment-level BC enrichment. Null when no BC match found. */
  buyer_note?: string | null;
  ship_notes?: string | null;
  artist?: string | null;
  additional_fan_contribution?: number | null;
  /** Phase 11.1 — payment audit context (also surfaced in cockpit drawer). */
  payment_state?: string | null;
  paypal_transaction_id?: string | null;
  /** Phase 11.1 — true when the order included any BC-sourced enrichment. */
  bandcamp_enriched?: boolean;
}

function pickAddress(raw: Record<string, unknown> | null): PackingSlipAddress {
  if (!raw) {
    return {
      name: null,
      company: null,
      street1: null,
      street2: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    };
  }
  const s = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    name: s("name"),
    company: s("company"),
    street1: s("street1"),
    street2: s("street2"),
    city: s("city"),
    state: s("state"),
    postalCode: s("postalCode"),
    country: s("country"),
  };
}

/**
 * Phase 3.4 — load the packing slip payload for ONE shipstation_orders row.
 *
 * Exposed on the supabase client (service-role context) so the route handler
 * stays a thin wrapper. Phase 9 bulk print will call a sibling helper that
 * batches the same query over an array of ids.
 */
export async function fetchPackingSlipData(
  supabase: SupabaseClient,
  shipstationOrderUuid: string,
): Promise<PackingSlipData | null> {
  const { data: order, error } = await supabase
    .from("shipstation_orders")
    .select(
      `id, workspace_id, shipstation_order_id, order_number, order_date, customer_name,
       customer_email, ship_to, org_id, advanced_options,
       organizations ( name )`,
    )
    .eq("id", shipstationOrderUuid)
    .maybeSingle();
  if (error || !order) return null;

  const { data: items } = await supabase
    .from("shipstation_order_items")
    .select("sku, name, quantity, unit_price, item_index")
    .eq("shipstation_order_id", order.id)
    .order("item_index", { ascending: true });

  const org = order.organizations as unknown as { name?: string } | null;

  // ── Phase 11.1 — Bandcamp enrichment ───────────────────────────────────
  // Resolve the BC payment_id from SS customField1 (operator-configurable
  // string; we extract the first run of >=4 digits via the shared parser).
  const adv = (order.advanced_options ?? {}) as Record<string, unknown>;
  const customField1 = typeof adv.customField1 === "string" ? adv.customField1 : null;
  const paymentId = parsePaymentIdFromCustomField(customField1);

  const enrichment = paymentId
    ? await loadBandcampEnrichment(supabase, {
        workspaceId: order.workspace_id as string,
        paymentId,
        skus: (items ?? [])
          .map((i) => i.sku)
          .filter((s): s is string => typeof s === "string" && s.length > 0),
      })
    : null;

  // Pull customs descriptions from any already-printed warehouse_shipment_items
  // for this SS order. Lets the slip show "Vinyl Record - 1 piece" style lines
  // for international packages.
  const customsBySku = await loadCustomsDescriptions(supabase, {
    workspaceId: order.workspace_id as string,
    shipstationOrderIdText: String(order.shipstation_order_id),
  });

  return {
    shipstation_order_id_internal: order.id,
    shipstation_order_id: order.shipstation_order_id as unknown as number,
    order_number: order.order_number,
    order_date: order.order_date,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    ship_to: pickAddress(order.ship_to as Record<string, unknown> | null),
    org_name: org?.name ?? null,
    org_id: order.org_id,
    items: (items ?? []).map((it) => {
      const enr = enrichment?.itemBySku.get((it.sku ?? "").toUpperCase()) ?? null;
      return {
        sku: it.sku,
        name: it.name,
        quantity: it.quantity,
        unit_price: it.unit_price,
        artist: enr?.artist ?? null,
        album_title: enr?.album_title ?? null,
        image_url: enr?.image_url ?? null,
        customs_description: it.sku ? (customsBySku.get(it.sku) ?? null) : null,
      };
    }),
    buyer_note: enrichment?.buyer_note ?? null,
    ship_notes: enrichment?.ship_notes ?? null,
    artist: enrichment?.primaryArtist ?? null,
    additional_fan_contribution: enrichment?.additional_fan_contribution ?? null,
    payment_state: enrichment?.payment_state ?? null,
    paypal_transaction_id: enrichment?.paypal_transaction_id ?? null,
    bandcamp_enriched: !!enrichment,
  };
}

// ── Phase 11.1 helpers ────────────────────────────────────────────────────

interface BandcampItemEnrichment {
  artist: string | null;
  album_title: string | null;
  image_url: string | null;
}

interface BandcampOrderEnrichment {
  buyer_note: string | null;
  ship_notes: string | null;
  additional_fan_contribution: number | null;
  payment_state: string | null;
  paypal_transaction_id: string | null;
  /** Most-frequent artist on the order — used in slip header.  */
  primaryArtist: string | null;
  itemBySku: Map<string, BandcampItemEnrichment>;
}

async function loadBandcampEnrichment(
  supabase: SupabaseClient,
  input: { workspaceId: string; paymentId: number; skus: string[] },
): Promise<BandcampOrderEnrichment | null> {
  const { data: salesRows } = await supabase
    .from("bandcamp_sales")
    .select(
      "artist, album_title, sku, buyer_note, ship_notes, additional_fan_contribution, payment_state, paypal_transaction_id",
    )
    .eq("workspace_id", input.workspaceId)
    .eq("bandcamp_transaction_id", input.paymentId);

  if (!salesRows || salesRows.length === 0) return null;

  // Payment-level fields are identical across rows for the same transaction;
  // take the first non-null for each.
  const first = (key: keyof (typeof salesRows)[number]): unknown => {
    for (const r of salesRows) {
      const v = r[key];
      if (v != null && v !== "") return v;
    }
    return null;
  };

  // Build SKU → item enrichment map. Pull image_url from
  // bandcamp_product_mappings via SKU (the BC sales row doesn't carry it).
  const itemBySku = new Map<string, BandcampItemEnrichment>();
  for (const r of salesRows) {
    if (!r.sku) continue;
    const key = String(r.sku).toUpperCase();
    if (!itemBySku.has(key)) {
      itemBySku.set(key, {
        artist: (r.artist as string | null) ?? null,
        album_title: (r.album_title as string | null) ?? null,
        image_url: null,
      });
    }
  }
  if (input.skus.length > 0) {
    const { data: mappings } = await supabase
      .from("bandcamp_product_mappings")
      .select("sku, bandcamp_image_url")
      .eq("workspace_id", input.workspaceId)
      .in("sku", input.skus);
    for (const m of mappings ?? []) {
      const key = String(m.sku).toUpperCase();
      const existing = itemBySku.get(key);
      if (existing) {
        existing.image_url = (m.bandcamp_image_url as string | null) ?? null;
      } else {
        itemBySku.set(key, {
          artist: null,
          album_title: null,
          image_url: (m.bandcamp_image_url as string | null) ?? null,
        });
      }
    }
  }

  // Most-frequent artist across line items — used in slip header for
  // multi-album orders we still want a single artist callout.
  const artistTally = new Map<string, number>();
  for (const r of salesRows) {
    if (typeof r.artist === "string" && r.artist.length > 0) {
      artistTally.set(r.artist, (artistTally.get(r.artist) ?? 0) + 1);
    }
  }
  let primaryArtist: string | null = null;
  let maxCount = 0;
  for (const [artist, count] of artistTally) {
    if (count > maxCount) {
      primaryArtist = artist;
      maxCount = count;
    }
  }

  return {
    buyer_note: (first("buyer_note") as string | null) ?? null,
    ship_notes: (first("ship_notes") as string | null) ?? null,
    additional_fan_contribution: (first("additional_fan_contribution") as number | null) ?? null,
    payment_state: (first("payment_state") as string | null) ?? null,
    paypal_transaction_id: (first("paypal_transaction_id") as string | null) ?? null,
    primaryArtist,
    itemBySku,
  };
}

async function loadCustomsDescriptions(
  supabase: SupabaseClient,
  input: { workspaceId: string; shipstationOrderIdText: string },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { data: ws } = await supabase
    .from("warehouse_shipments")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("shipstation_order_id", input.shipstationOrderIdText)
    .order("ship_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!ws) return out;
  const { data: rows } = await supabase
    .from("warehouse_shipment_items")
    .select("sku, customs_description")
    .eq("shipment_id", ws.id);
  for (const r of rows ?? []) {
    if (r.sku && typeof r.customs_description === "string") {
      out.set(r.sku as string, r.customs_description as string);
    }
  }
  return out;
}
