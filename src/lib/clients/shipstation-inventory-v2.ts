/**
 * ShipStation v2 inventory client (api.shipstation.com — `api-key` header).
 *
 * Plan §7.1.6: this module exports ONLY batch helpers. There is no
 * `getInventoryBySku(sku: string)` convenience function. Even internal
 * helpers route through the batch path. The CI lint guard
 * `scripts/check-v2-inventory-batch.sh` greps for any reintroduction of
 * a single-SKU read helper and fails the build.
 *
 * Why: someone will invariably reinvent the convenience helper inside an
 * admin page or a Trigger task and silently burn the v2 60 req/min
 * budget. Make it a build error instead.
 *
 * Decision matrix at the 1 → 0 inventory boundary (Phase 0 Patch D2 probe,
 * 2026-04-17 — see plan §5.1):
 *   - `decrement quantity: N`         → 200, including the 1 → 0 step. **Use this.**
 *   - `adjust quantity: 0`            → 200 (asymmetric vs seed; documented safety net).
 *   - `modify new_available: 0`       → 400 "Must be greater than or equal to 1." **Forbidden.**
 *
 * Writes (single-SKU adjustments) are fine — only reads must batch.
 */

import { env } from "@/lib/shared/env";

const V2_BASE_URL = "https://api.shipstation.com";

/** Hard cap on a single `listInventory` batch (URL length safety). */
export const V2_INVENTORY_LIST_BATCH_LIMIT = 50;

export interface InventoryRecord {
  sku: string;
  on_hand: number;
  allocated: number;
  available: number;
  inventory_warehouse_id: string;
  inventory_location_id: string;
  last_updated_at: string;
}

export interface ListInventoryParams {
  /**
   * Batch of SKUs to fetch. The batch is split into chunks of
   * V2_INVENTORY_LIST_BATCH_LIMIT and queried in sequence.
   *
   * Pass `undefined` to enumerate the entire inventory (cursor-paged).
   */
  skus?: string[];
  inventory_warehouse_id?: string;
  inventory_location_id?: string;
  /** v2 cursor (returned in response `links.next`). Internal — call-sites should batch via `skus`. */
  cursor?: string;
  /** Per-page record limit when enumerating without a SKU filter. Defaults to 100. */
  limit?: number;
}

export type V2TransactionType = "increment" | "decrement" | "adjust" | "modify";

export interface AdjustInventoryParams {
  sku: string;
  inventory_warehouse_id: string;
  inventory_location_id: string;
  transaction_type: V2TransactionType;
  /**
   * For `increment` / `decrement` / `adjust` this is the magnitude (>= 1
   * for increment/decrement; `adjust` accepts 0 on existing rows per the
   * Phase 0 Patch D2 probe). For `modify` it is unused — pass
   * `new_available` instead.
   */
  quantity?: number;
  /** Required when `transaction_type === "modify"`. Must be >= 1 (cannot zero a SKU via modify). */
  new_available?: number;
  cost?: { amount: number; currency: string };
  condition?: "sellable" | "damaged" | "expired" | "qa_hold";
  reason: string;
  notes?: string;
  effective_at?: string;
}

interface V2InventoryListResponse {
  inventory: InventoryRecord[];
  links?: {
    next?: { href?: string } | null;
  };
}

async function v2Fetch<T>(path: string, options?: RequestInit): Promise<T> {
  const apiKey = env().SHIPSTATION_V2_API_KEY;
  if (!apiKey) {
    throw new Error("SHIPSTATION_V2_API_KEY is not configured");
  }
  const response = await fetch(`${V2_BASE_URL}${path}`, {
    ...options,
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ShipStation v2 ${response.status} ${path}: ${body}`);
  }

  // Phase 2B fix (2026-04-18 §15.3 probe finding #1): v2 inventory POST
  // returns 200 with an EMPTY body on success. Calling response.json()
  // on an empty body throws "Unexpected end of JSON input" — which
  // bubbled up to the caller as a phantom failure, the
  // external_sync_events ledger then marked the row 'error', the task
  // retried, and v2 idempotently re-applied the write but the operator
  // dashboard filled with red error rows.
  //
  // Read the body as text first; if empty (or whitespace-only), return
  // an empty object cast to T. Callers that depend on the response body
  // already null-check the fields. Status 204 is also handled trivially.
  if (response.status === 204) {
    return {} as T;
  }
  const raw = await response.text();
  if (!raw || raw.trim().length === 0) {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `ShipStation v2 ${path}: failed to parse response body (${err instanceof Error ? err.message : "unknown"}). Raw: ${raw.slice(0, 200)}`,
    );
  }
}

/**
 * Fetch inventory records for an explicit batch of SKUs (or for the whole
 * tenant via cursor pagination if `skus` is omitted).
 *
 * The batch is automatically chunked into groups of
 * V2_INVENTORY_LIST_BATCH_LIMIT to stay under URL length limits and to
 * avoid 429s on giant requests. All chunks are awaited sequentially —
 * concurrency is the caller's responsibility (the v2 API allows ~60
 * req/min and the shipstation queue is `concurrencyLimit: 1`).
 */
export async function listInventory(params: ListInventoryParams = {}): Promise<InventoryRecord[]> {
  if (!params.skus || params.skus.length === 0) {
    return enumerateInventory(params);
  }

  const out: InventoryRecord[] = [];
  for (let i = 0; i < params.skus.length; i += V2_INVENTORY_LIST_BATCH_LIMIT) {
    const chunk = params.skus.slice(i, i + V2_INVENTORY_LIST_BATCH_LIMIT);
    const sp = new URLSearchParams();
    sp.set("sku", chunk.join(","));
    if (params.inventory_warehouse_id)
      sp.set("inventory_warehouse_id", params.inventory_warehouse_id);
    if (params.inventory_location_id) sp.set("inventory_location_id", params.inventory_location_id);
    const json = await v2Fetch<V2InventoryListResponse>(`/v2/inventory?${sp.toString()}`);
    for (const row of json.inventory ?? []) out.push(row);
  }
  return out;
}

async function enumerateInventory(params: ListInventoryParams): Promise<InventoryRecord[]> {
  const out: InventoryRecord[] = [];
  let cursor = params.cursor;
  const limit = params.limit ?? 100;

  do {
    const sp = new URLSearchParams();
    sp.set("limit", String(limit));
    if (params.inventory_warehouse_id)
      sp.set("inventory_warehouse_id", params.inventory_warehouse_id);
    if (params.inventory_location_id) sp.set("inventory_location_id", params.inventory_location_id);
    if (cursor) sp.set("cursor", cursor);

    const json = await v2Fetch<V2InventoryListResponse>(`/v2/inventory?${sp.toString()}`);
    for (const row of json.inventory ?? []) out.push(row);

    cursor = extractCursor(json.links?.next?.href ?? null);
  } while (cursor);

  return out;
}

function extractCursor(href: string | null): string | undefined {
  if (!href) return undefined;
  try {
    const parsed = new URL(href, V2_BASE_URL);
    return parsed.searchParams.get("cursor") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Single-SKU write — explicitly allowed (batching is for reads only). The
 * caller is expected to wrap this in an `external_sync_events` ledger
 * row (plan §1.4.2) before invoking it.
 *
 * Validation enforced here:
 *   - `increment` / `decrement` require `quantity >= 1`.
 *   - `adjust` allows `quantity` 0 or higher (proven by Phase 0 Patch D2 probe).
 *   - `modify` requires `new_available >= 1` (Phase 0 Patch D2: cannot zero via modify).
 *
 * Callers that need to land `available: 0` MUST use `decrement` with the
 * matching delta (or `adjust` with `quantity: 0` as the documented safety net).
 * `modify new_available: 0` is rejected by the API and by this client.
 */
export async function adjustInventoryV2(params: AdjustInventoryParams): Promise<unknown> {
  const { transaction_type } = params;

  if (transaction_type === "modify") {
    if (params.new_available === undefined) {
      throw new Error("adjustInventoryV2 modify requires new_available");
    }
    if (params.new_available < 1) {
      throw new Error(
        `adjustInventoryV2 modify rejected: new_available ${params.new_available} < 1. ` +
          `ShipStation v2 cannot zero a SKU via modify; use decrement or adjust quantity:0.`,
      );
    }
  } else {
    if (params.quantity === undefined) {
      throw new Error(`adjustInventoryV2 ${transaction_type} requires quantity`);
    }
    if (transaction_type !== "adjust" && params.quantity < 1) {
      throw new Error(
        `adjustInventoryV2 ${transaction_type} rejected: quantity ${params.quantity} < 1. ` +
          `Use transaction_type: "adjust" with quantity 0 to zero a tracked row.`,
      );
    }
    if (params.quantity < 0) {
      throw new Error(`adjustInventoryV2 ${transaction_type} rejected: negative quantity`);
    }
  }

  const body: Record<string, unknown> = {
    sku: params.sku,
    inventory_warehouse_id: params.inventory_warehouse_id,
    inventory_location_id: params.inventory_location_id,
    transaction_type,
    reason: params.reason,
  };
  if (params.quantity !== undefined) body.quantity = params.quantity;
  if (params.new_available !== undefined) body.new_available = params.new_available;
  if (params.cost) body.cost = params.cost;
  if (params.condition) body.condition = params.condition;
  if (params.notes) body.notes = params.notes;
  if (params.effective_at) body.effective_at = params.effective_at;

  return v2Fetch<unknown>("/v2/inventory", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── Warehouse / location discovery (used by Phase 3 seed UI) ────────────────

export interface V2InventoryWarehouse {
  inventory_warehouse_id: string;
  name: string | null;
}

export interface V2InventoryLocation {
  inventory_location_id: string;
  inventory_warehouse_id: string;
  name: string | null;
}

interface V2WarehouseListResponse {
  inventory_warehouses?: Array<Record<string, unknown>>;
  warehouses?: Array<Record<string, unknown>>;
}

interface V2LocationListResponse {
  inventory_locations?: Array<Record<string, unknown>>;
  locations?: Array<Record<string, unknown>>;
}

/**
 * List configured ShipStation v2 inventory warehouses. Single tenant call —
 * cached at the call-site (admin page, seed task) is encouraged. The shape
 * varies slightly by API version (`inventory_warehouses` vs `warehouses`
 * vs `warehouse_id` field), so we normalize defensively.
 */
export async function listInventoryWarehouses(): Promise<V2InventoryWarehouse[]> {
  const json = await v2Fetch<V2WarehouseListResponse>("/v2/inventory_warehouses");
  const raw = json.inventory_warehouses ?? json.warehouses ?? [];
  return raw.map((w) => {
    const id = (w.inventory_warehouse_id as string | undefined) ?? (w.warehouse_id as string);
    const name = (w.name as string | undefined) ?? null;
    return { inventory_warehouse_id: id, name };
  });
}

/**
 * List inventory locations within a given warehouse. Same defensive
 * normalization as warehouses.
 */
export async function listInventoryLocations(
  inventoryWarehouseId: string,
): Promise<V2InventoryLocation[]> {
  const sp = new URLSearchParams({ inventory_warehouse_id: inventoryWarehouseId });
  const json = await v2Fetch<V2LocationListResponse>(`/v2/inventory_locations?${sp.toString()}`);
  const raw = json.inventory_locations ?? json.locations ?? [];
  return raw.map((l) => {
    const id = (l.inventory_location_id as string | undefined) ?? (l.location_id as string);
    const name = (l.name as string | undefined) ?? null;
    const whId = (l.inventory_warehouse_id as string | undefined) ?? inventoryWarehouseId;
    return {
      inventory_location_id: id,
      inventory_warehouse_id: whId,
      name,
    };
  });
}

// ─── Location mutations (Saturday Workstream 3 — locator + count session) ───
//
// Plan §C.11. createLocation/updateLocation/deactivateLocation Server Actions
// in src/actions/locations.ts call these to mirror our app's location records
// to ShipStation v2. Our app is the source of truth (CLAUDE.md Rule #76).
// deleteInventoryLocation is exported for future cleanup tooling but is NOT
// auto-called by deactivateLocation() (R-21 — silent v2 deletes are too easy
// to misuse; explicit operator script lives in §22 deferred items).

interface V2InventoryLocationCreateBody {
  inventory_warehouse_id: string;
  name: string;
}

interface V2InventoryLocationUpdateBody {
  name?: string;
}

/**
 * Create a new inventory location in ShipStation v2.
 * Mirrored from createLocation() Server Action when staff create a location
 * in our app. On 409/duplicate the caller (createLocation) is responsible
 * for falling back to listInventoryLocations() + ID resolution per R-22.
 */
export async function createInventoryLocation(
  body: V2InventoryLocationCreateBody,
): Promise<V2InventoryLocation> {
  const json = await v2Fetch<Record<string, unknown>>("/v2/inventory_locations", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    inventory_location_id:
      (json.inventory_location_id as string | undefined) ?? (json.location_id as string),
    inventory_warehouse_id:
      (json.inventory_warehouse_id as string | undefined) ?? body.inventory_warehouse_id,
    name: (json.name as string | undefined) ?? body.name,
  };
}

/**
 * Update an inventory location (rename) in ShipStation v2.
 * Called by updateLocation() Server Action on rename. Per v4 hardening,
 * the caller invokes this BEFORE updating the local row so a v2 failure
 * leaves the local row unchanged (no "renamed locally but not in ShipStation"
 * drift).
 */
export async function updateInventoryLocation(
  inventoryLocationId: string,
  body: V2InventoryLocationUpdateBody,
): Promise<V2InventoryLocation> {
  const json = await v2Fetch<Record<string, unknown>>(
    `/v2/inventory_locations/${inventoryLocationId}`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
  );
  return {
    inventory_location_id:
      (json.inventory_location_id as string | undefined) ?? inventoryLocationId,
    inventory_warehouse_id: json.inventory_warehouse_id as string,
    name: (json.name as string | undefined) ?? null,
  };
}

/**
 * Delete an inventory location in ShipStation v2.
 * Defined for future cleanup tooling. NOT auto-called by deactivateLocation()
 * (Plan §17.1.b OQ-1 hardening: deactivate is local-only; ShipStation cleanup
 * is operator-gated per §22 deferred items).
 */
export async function deleteInventoryLocation(inventoryLocationId: string): Promise<void> {
  await v2Fetch<unknown>(`/v2/inventory_locations/${inventoryLocationId}`, { method: "DELETE" });
}

// ─── EXPLICITLY NOT EXPORTED ─────────────────────────────────────────────────
// Do NOT add a single-SKU read helper. The CI lint guard at
// scripts/check-v2-inventory-batch.sh greps this file for forbidden
// symbol shapes (e.g. `getInventoryBySku`, `findInventoryBySku`,
// `inventoryFor(sku: string)`) and fails the build if they appear.
//
// If you genuinely need a single-SKU read, call:
//   const [record] = await listInventory({ skus: [sku] });
// The single-element batch path costs the same one HTTP call.
