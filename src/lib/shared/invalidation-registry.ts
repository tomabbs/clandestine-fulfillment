import { queryKeys } from "./query-keys";

/**
 * Maps table names to arrays of query key prefixes that should be invalidated
 * when that table changes. Used by useAppMutation to auto-invalidate on success.
 */
export const invalidationRegistry: Record<string, readonly (readonly string[])[]> = {
  warehouse_products: [queryKeys.products.all, queryKeys.inventory.all],
  warehouse_product_variants: [queryKeys.products.all, queryKeys.inventory.all],
  warehouse_product_images: [queryKeys.products.all],
  warehouse_inventory_levels: [queryKeys.inventory.all],
  warehouse_inventory_activity: [queryKeys.inventory.all],
  warehouse_orders: [queryKeys.orders.all],
  warehouse_order_items: [queryKeys.orders.all],
  warehouse_shipments: [queryKeys.shipments.all, queryKeys.orders.all],
  warehouse_shipment_items: [queryKeys.shipments.all],
  warehouse_tracking_events: [queryKeys.shipments.all],
  warehouse_inbound_shipments: [queryKeys.inbound.all],
  warehouse_inbound_items: [queryKeys.inbound.all],
  warehouse_billing_snapshots: [queryKeys.billing.all],
  warehouse_billing_adjustments: [queryKeys.billing.all],
  warehouse_billing_rules: [queryKeys.billing.all],
  warehouse_format_costs: [queryKeys.billing.all],
  warehouse_format_rules: [queryKeys.billing.all],
  warehouse_review_queue: [queryKeys.reviewQueue.all],
  support_conversations: [queryKeys.support.all],
  support_messages: [queryKeys.support.all],
  client_store_connections: [queryKeys.storeConnections.all, queryKeys.channels.all],
  client_store_sku_mappings: [queryKeys.storeConnections.all],
  organizations: [queryKeys.clients.all],
  channel_sync_log: [queryKeys.channels.all],
  bandcamp_connections: [queryKeys.channels.all],
  warehouse_pirate_ship_imports: [queryKeys.pirateShipImports.all],
};
