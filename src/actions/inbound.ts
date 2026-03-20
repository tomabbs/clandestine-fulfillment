"use server";

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { requireAuth } from "@/lib/server/auth-context";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import { isValidTransition } from "@/lib/shared/inbound-transitions";
import type {
  InboundStatus,
  WarehouseInboundItem,
  WarehouseInboundShipment,
} from "@/lib/shared/types";

// === Zod Schemas ===

const inboundFiltersSchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(["expected", "arrived", "checking_in", "checked_in", "issue"]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export type InboundFilters = z.infer<typeof inboundFiltersSchema>;

const createInboundItemSchema = z.object({
  sku: z.string().optional(),
  title: z.string().min(1),
  format: z.string().optional(),
  expected_quantity: z.number().int().min(1),
});

const createInboundSchema = z.object({
  tracking_number: z.string().min(1).optional(),
  carrier: z.string().min(1).optional(),
  expected_date: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(createInboundItemSchema).min(1, "At least one item is required"),
});

export type CreateInboundInput = z.infer<typeof createInboundSchema>;
export type CreateInboundResult = { success: true; id: string } | { success: false; error: string };

const checkInItemSchema = z.object({
  itemId: z.string().uuid(),
  receivedQty: z.number().int().min(0),
  conditionNotes: z.string().optional(),
  locationId: z.string().uuid().optional(),
});

export type CheckInItemInput = z.infer<typeof checkInItemSchema>;

// === Server Actions ===

export type InboundShipmentWithOrg = WarehouseInboundShipment & {
  org_name: string | null;
  item_count: number;
  submitter_name: string | null;
};

export async function getInboundShipments(filters?: InboundFilters): Promise<{
  data: InboundShipmentWithOrg[];
  count: number;
}> {
  const parsed = inboundFiltersSchema.parse(filters ?? {});
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("warehouse_inbound_shipments")
    .select(
      "*, organizations!inner(name), warehouse_inbound_items(id), users!warehouse_inbound_shipments_submitted_by_fkey(name)",
      { count: "exact" },
    );

  if (parsed.orgId) {
    query = query.eq("org_id", parsed.orgId);
  }
  if (parsed.status) {
    query = query.eq("status", parsed.status);
  }
  if (parsed.dateFrom) {
    query = query.gte("expected_date", parsed.dateFrom);
  }
  if (parsed.dateTo) {
    query = query.lte("expected_date", parsed.dateTo);
  }

  const offset = (parsed.page - 1) * parsed.pageSize;
  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + parsed.pageSize - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Failed to fetch inbound shipments: ${error.message}`);
  }

  const mapped: InboundShipmentWithOrg[] = (data ?? []).map((row: Record<string, unknown>) => {
    const org = row.organizations as { name: string } | null;
    const items = row.warehouse_inbound_items as { id: string }[] | null;
    const submitter = row.users as { name: string } | null;

    const { organizations: _o, warehouse_inbound_items: _i, users: _u, ...shipment } = row;

    return {
      ...shipment,
      org_name: org?.name ?? null,
      item_count: items?.length ?? 0,
      submitter_name: submitter?.name ?? null,
    } as InboundShipmentWithOrg;
  });

  return { data: mapped, count: count ?? 0 };
}

export type InboundDetailResult = WarehouseInboundShipment & {
  org_name: string | null;
  items: WarehouseInboundItem[];
};

export async function getInboundDetail(id: string): Promise<InboundDetailResult> {
  z.string().uuid().parse(id);
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("warehouse_inbound_shipments")
    .select("*, organizations!inner(name), warehouse_inbound_items(*)")
    .eq("id", id)
    .single();

  if (error || !data) {
    throw new Error(`Inbound shipment not found: ${error?.message ?? "no data"}`);
  }

  const row = data as Record<string, unknown>;
  const org = row.organizations as { name: string } | null;
  const items = (row.warehouse_inbound_items as WarehouseInboundItem[]) ?? [];
  const { organizations: _o, warehouse_inbound_items: _i, ...shipment } = row;

  return {
    ...shipment,
    org_name: org?.name ?? null,
    items,
  } as InboundDetailResult;
}

export async function createInbound(input: CreateInboundInput): Promise<CreateInboundResult> {
  try {
    const parsedResult = createInboundSchema.safeParse(input);
    if (!parsedResult.success) {
      return { success: false, error: "Please complete all required inbound fields." };
    }
    const parsed = parsedResult.data;
    const { userRecord } = await requireAuth();
    const serviceClient = createServiceRoleClient();

    if (!userRecord.org_id) {
      return {
        success: false,
        error: "Your user is not linked to an organization. Contact support to fix your account.",
      };
    }

    // Create the shipment using service role with explicit user/org context checks.
    const { data: shipment, error: shipmentError } = await serviceClient
      .from("warehouse_inbound_shipments")
      .insert({
        workspace_id: userRecord.workspace_id,
        org_id: userRecord.org_id,
        tracking_number: parsed.tracking_number ?? null,
        carrier: parsed.carrier ?? null,
        expected_date: parsed.expected_date ?? null,
        status: "expected" as InboundStatus,
        notes: parsed.notes ?? null,
        submitted_by: userRecord.id,
      })
      .select("id")
      .single();

    if (shipmentError || !shipment) {
      return {
        success: false,
        error: `Failed to create inbound shipment: ${shipmentError?.message ?? "unknown error"}`,
      };
    }

    // Look up existing SKUs to determine which items need new products
    const itemsWithSku = parsed.items.filter((item) => item.sku);
    let existingVariants: Record<string, string> = {};
    if (itemsWithSku.length > 0) {
      const skus = itemsWithSku.map((i) => i.sku).filter(Boolean) as string[];
      const { data: variants } = await serviceClient
        .from("warehouse_product_variants")
        .select("id, sku")
        .eq("workspace_id", userRecord.workspace_id)
        .in("sku", skus);

      existingVariants = Object.fromEntries((variants ?? []).map((v) => [v.sku, v.id]));
    }

    // Insert inbound items
    const itemRows = parsed.items.map((item) => ({
      inbound_shipment_id: shipment.id,
      workspace_id: userRecord.workspace_id,
      sku: item.sku ?? `PENDING-${crypto.randomUUID().slice(0, 8)}`,
      expected_quantity: item.expected_quantity,
      received_quantity: null,
      condition_notes: null,
      location_id: null,
    }));

    const { data: insertedItems, error: itemsError } = await serviceClient
      .from("warehouse_inbound_items")
      .insert(itemRows)
      .select("id, sku");

    if (itemsError) {
      return { success: false, error: `Failed to create inbound items: ${itemsError.message}` };
    }

    // Flag items with no matching SKU for product creation
    const itemsNeedingProducts = (insertedItems ?? []).filter((item) => {
      const originalItem = parsed.items.find(
        (i) => i.sku === item.sku || item.sku.startsWith("PENDING-"),
      );
      return originalItem && (!originalItem.sku || !existingVariants[originalItem.sku]);
    });

    // Also include items where user provided a SKU but it doesn't exist
    const itemsWithUnknownSku = (insertedItems ?? []).filter((item) => {
      const originalItem = parsed.items.find((i) => i.sku === item.sku);
      return originalItem?.sku && !existingVariants[originalItem.sku];
    });

    const allItemsNeedingProducts = Array.from(
      new Set([...itemsNeedingProducts, ...itemsWithUnknownSku].map((i) => i.id)),
    );

    if (allItemsNeedingProducts.length > 0) {
      await tasks.trigger("inbound-product-create", {
        inboundItemIds: allItemsNeedingProducts,
      });
    }

    return { success: true, id: shipment.id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unexpected inbound error: ${msg}` };
  }
}

export async function markArrived(id: string): Promise<void> {
  z.string().uuid().parse(id);
  const supabase = await createServerSupabaseClient();

  const { data: shipment, error: fetchError } = await supabase
    .from("warehouse_inbound_shipments")
    .select("status")
    .eq("id", id)
    .single();

  if (fetchError || !shipment) {
    throw new Error("Shipment not found");
  }

  if (!isValidTransition(shipment.status as InboundStatus, "arrived")) {
    throw new Error(`Cannot transition from '${shipment.status}' to 'arrived'`);
  }

  const { error } = await supabase
    .from("warehouse_inbound_shipments")
    .update({
      status: "arrived" as InboundStatus,
      actual_arrival_date: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark arrived: ${error.message}`);
  }
}

export async function beginCheckIn(id: string): Promise<void> {
  z.string().uuid().parse(id);
  const supabase = await createServerSupabaseClient();

  const { data: shipment, error: fetchError } = await supabase
    .from("warehouse_inbound_shipments")
    .select("status")
    .eq("id", id)
    .single();

  if (fetchError || !shipment) {
    throw new Error("Shipment not found");
  }

  if (!isValidTransition(shipment.status as InboundStatus, "checking_in")) {
    throw new Error(`Cannot transition from '${shipment.status}' to 'checking_in'`);
  }

  // Get current user for checked_in_by
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: userData } = await supabase
    .from("users")
    .select("id")
    .eq("auth_user_id", user.id)
    .single();

  const { error } = await supabase
    .from("warehouse_inbound_shipments")
    .update({
      status: "checking_in" as InboundStatus,
      checked_in_by: userData?.id ?? null,
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to begin check-in: ${error.message}`);
  }
}

export async function checkInItem(input: CheckInItemInput): Promise<void> {
  const parsed = checkInItemSchema.parse(input);
  const supabase = await createServerSupabaseClient();

  // Verify the item exists and its shipment is in checking_in status
  const { data: item, error: itemError } = await supabase
    .from("warehouse_inbound_items")
    .select("id, inbound_shipment_id")
    .eq("id", parsed.itemId)
    .single();

  if (itemError || !item) {
    throw new Error("Inbound item not found");
  }

  const { data: shipment, error: shipmentError } = await supabase
    .from("warehouse_inbound_shipments")
    .select("status")
    .eq("id", item.inbound_shipment_id)
    .single();

  if (shipmentError || !shipment) {
    throw new Error("Parent shipment not found");
  }

  if (shipment.status !== "checking_in") {
    throw new Error(`Cannot check in items when shipment status is '${shipment.status}'`);
  }

  const { error } = await supabase
    .from("warehouse_inbound_items")
    .update({
      received_quantity: parsed.receivedQty,
      condition_notes: parsed.conditionNotes ?? null,
      location_id: parsed.locationId ?? null,
    })
    .eq("id", parsed.itemId);

  if (error) {
    throw new Error(`Failed to check in item: ${error.message}`);
  }
}

export async function completeCheckIn(shipmentId: string): Promise<{ taskRunId: string }> {
  z.string().uuid().parse(shipmentId);
  const supabase = await createServerSupabaseClient();

  // Verify shipment is in checking_in status
  const { data: shipment, error: fetchError } = await supabase
    .from("warehouse_inbound_shipments")
    .select("status")
    .eq("id", shipmentId)
    .single();

  if (fetchError || !shipment) {
    throw new Error("Shipment not found");
  }

  if (!isValidTransition(shipment.status as InboundStatus, "checked_in")) {
    throw new Error(`Cannot transition from '${shipment.status}' to 'checked_in'`);
  }

  // Verify all items have been checked in
  const { data: items, error: itemsError } = await supabase
    .from("warehouse_inbound_items")
    .select("id, received_quantity")
    .eq("inbound_shipment_id", shipmentId);

  if (itemsError) {
    throw new Error(`Failed to fetch items: ${itemsError.message}`);
  }

  const uncheckedItems = (items ?? []).filter((item) => item.received_quantity === null);
  if (uncheckedItems.length > 0) {
    throw new Error(
      `Cannot complete check-in: ${uncheckedItems.length} item(s) have not been checked in`,
    );
  }

  // Fire completion task (Rule #12: pass IDs only)
  const handle = await tasks.trigger("inbound-checkin-complete", {
    shipmentId,
  });

  return { taskRunId: handle.id };
}
