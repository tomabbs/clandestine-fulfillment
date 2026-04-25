// Re-export role types from constants (Rule #10: all shared types in one place)
export type { ClientRole, StaffRole, UserRole } from "./constants";

// === Union Types ===

export type InventorySource =
  | "shopify"
  | "bandcamp"
  | "squarespace"
  | "woocommerce"
  | "shipstation"
  | "manual"
  | "inbound"
  | "preorder"
  | "backfill"
  // Phase 5 (2026-04-13): tiered ShipStation v2 ↔ DB reconcile sensor.
  // Used by `shipstation-bandcamp-reconcile-{hot,warm,cold}` when v2 is treated
  // as the source of truth and our DB is adjusted to match. Mirrored in
  // supabase/migrations/20260413000030_phase5_reconcile_and_sku_sync_status.sql
  // (warehouse_inventory_activity.source CHECK constraint).
  | "reconcile"
  // Saturday Workstream 2 (2026-04-18): manual inventory count entry by staff
  // via /admin/inventory/manual-count (bulk table editor, absolute-set with
  // confirmation gate). Distinct from "manual" (per-SKU dialog adjustment
  // with free-text reason) so billing/audit can identify count-driven writes.
  // CHECK constraint extended in
  // supabase/migrations/20260418000001_phase4b_megaplan_closeout_and_count_session.sql.
  | "manual_inventory_count"
  // Saturday Workstream 3 (2026-04-18): per-location count session deltas
  // produced when completeCountSession() reconciles a location's counted
  // inventory back to warehouse_inventory_levels. Same migration as
  // manual_inventory_count.
  | "cycle_count"
  // Direct-Shopify cutover (2026-04-22, HRD-26): emitted with `delta = 0`
  // when our fanout layer lazily activates a Shopify inventory item at the
  // staff-selected default location via `inventoryActivate`. Recorded as an
  // audit row (no quantity change) so admin can grep when an SKU was activated
  // at a given timestamp without joining external_sync_events. CHECK constraint
  // extended in supabase/migrations/20260422000001_direct_shopify_metadata.sql.
  | "inventory_activate";

export type ReviewSeverity = "low" | "medium" | "high" | "critical";

export type ReviewStatus = "open" | "in_progress" | "resolved" | "suppressed";

export type ConnectionStatus = "pending" | "active" | "disabled_auth_failure" | "error";

/**
 * Phase 3 D1 — Direct-Shopify cutover state machine.
 *
 * ORTHOGONAL to `do_not_fanout`. Truth table in plan §9.4 D1; invalid
 * combinations rejected at the DB by `client_store_connections_cutover_dormancy_check`.
 *
 *  - legacy: pre-cutover. Either dormant (do_not_fanout=true) or active legacy
 *    fanout. SS Inventory Sync owns mirroring.
 *  - shadow: we push directly AND SS still mirrors. Every push event also
 *    writes to `connection_shadow_log` for 7-day comparison.
 *  - direct: cutover complete. The connection's storefront type is removed
 *    from `SHIPSTATION_V2_ECHO_SOURCES` via a row in `connection_echo_overrides`;
 *    SS becomes label-only for this connection.
 */
export type CutoverState = "legacy" | "shadow" | "direct";

/**
 * Phase 3 D4 — per-connection override of the static
 * `SHIPSTATION_V2_ECHO_SOURCES` set in `inventory-fanout.ts`.
 * Today only one type is supported; future override types extend this enum
 * + the DB CHECK constraint together.
 */
export type ConnectionEchoOverrideType = "exclude_from_v2_echo";

export type IntegrationHealthState =
  | "healthy"
  | "delayed"
  | "partial"
  | "manual_review"
  | "disconnected"
  // Phase 0 §9.1 D2 — Shopify variant `inventoryPolicy = CONTINUE` observed
  // for SKUs NOT on the per-channel preorder whitelist. Sync still flows,
  // but oversells are possible until the operator runs `auditShopifyPolicy`
  // (fixMode='fix_drift') or fixes the variants in Shopify Admin.
  // Surfaced on Channels page as an actionable warning, not a hard outage.
  | "policy_drift";

export type OrderSource =
  | "shopify"
  | "bandcamp"
  | "woocommerce"
  | "squarespace"
  | "discogs"
  | "manual";

export type MailOrderSource = "clandestine_shopify" | "clandestine_discogs";

export type PlatformFulfillmentStatus = "pending" | "sent" | "confirmed" | "failed";

export type ClientPayoutStatus = "pending" | "included_in_snapshot" | "paid";

export type InboundStatus = "expected" | "arrived" | "checking_in" | "checked_in" | "issue";

export type ConversationStatus =
  | "open"
  | "waiting_on_client"
  | "waiting_on_staff"
  | "resolved"
  | "closed";

export type SupportSourceChannel = "app" | "email" | "discogs" | "bandcamp_fan" | "system";
export type SupportDeliveryChannel = "app" | "email" | "discogs" | "bandcamp" | "system";
export type SupportMessageDirection = "inbound" | "outbound" | "internal";

export type StorePlatform = "shopify" | "woocommerce" | "squarespace" | "bigcommerce" | "discogs";

// === Core ===

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  inventory_sync_paused: boolean;
  inventory_sync_paused_at: string | null;
  inventory_sync_paused_by: string | null;
  // Tier 1 hardening #1 — per-integration kill switches
  shipstation_sync_paused: boolean;
  shipstation_sync_paused_at: string | null;
  shipstation_sync_paused_by: string | null;
  bandcamp_sync_paused: boolean;
  bandcamp_sync_paused_at: string | null;
  bandcamp_sync_paused_by: string | null;
  clandestine_shopify_sync_paused: boolean;
  clandestine_shopify_sync_paused_at: string | null;
  clandestine_shopify_sync_paused_by: string | null;
  client_store_sync_paused: boolean;
  client_store_sync_paused_at: string | null;
  client_store_sync_paused_by: string | null;
  // Tier 1 hardening #13 — percentage rollout for Phase 4 fanout
  fanout_rollout_percent: number;
  // Phase 4 — default ShipStation v2 (inventory_warehouse_id, inventory_location_id)
  // used by background fanout tasks. NULL ⇒ v2 fanout short-circuits for this workspace.
  shipstation_v2_inventory_warehouse_id: string | null;
  shipstation_v2_inventory_location_id: string | null;
}

export type IntegrationKillSwitchKey =
  | "shipstation"
  | "bandcamp"
  | "clandestine_shopify"
  | "client_store";

export type ServiceType = "full_service" | "storage_only" | "drop_ship";

export interface Organization {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  pirate_ship_name: string | null;
  billing_email: string | null;
  onboarding_state: Record<string, unknown>;
  storage_fee_waived: boolean;
  warehouse_grace_period_ends_at: string | null;
  service_type: ServiceType;
  shopify_vendor_name: string | null;
  stripe_customer_id: string | null;
  created_at: string;
}

export interface User {
  id: string;
  auth_user_id: string;
  email: string;
  name: string | null;
  role: string;
  workspace_id: string;
  org_id: string | null;
  last_seen_at: string | null;
  last_seen_page: string | null;
  created_at: string;
}

export interface PortalAdminSettings {
  id: string;
  workspace_id: string;
  org_id: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// === Products ===

export interface WarehouseProduct {
  id: string;
  workspace_id: string;
  org_id: string;
  shopify_product_id: string | null;
  title: string;
  vendor: string | null;
  product_type: string | null;
  status: "active" | "draft" | "archived";
  tags: string[];
  shopify_handle: string | null;
  images: Record<string, unknown>[];
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface WarehouseProductVariant {
  id: string;
  product_id: string;
  workspace_id: string;
  sku: string;
  shopify_variant_id: string | null;
  title: string | null;
  price: number | null;
  cost: number | null;
  compare_at_price: number | null;
  barcode: string | null;
  weight: number | null;
  weight_unit: string;
  option1_name: string | null;
  option1_value: string | null;
  format_name: string | null;
  street_date: string | null;
  is_preorder: boolean;
  bandcamp_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseProductImage {
  id: string;
  product_id: string;
  workspace_id: string;
  position: number;
  src: string;
  alt: string | null;
  shopify_image_id: string | null;
  created_at: string;
}

// === Inventory ===

export interface WarehouseInventoryLevel {
  id: string;
  variant_id: string;
  workspace_id: string;
  org_id: string | null;
  sku: string;
  available: number;
  committed: number;
  incoming: number;
  last_redis_write_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseLocation {
  id: string;
  workspace_id: string;
  name: string;
  barcode: string | null;
  location_type: "shelf" | "bin" | "floor" | "staging";
  is_active: boolean;
  created_at: string;
}

export interface WarehouseVariantLocation {
  id: string;
  variant_id: string;
  location_id: string;
  workspace_id: string;
  quantity: number;
  created_at: string;
  updated_at: string;
}

export interface WarehouseInventoryActivity {
  id: string;
  workspace_id: string;
  sku: string;
  delta: number;
  source: InventorySource;
  correlation_id: string;
  previous_quantity: number | null;
  new_quantity: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// === Orders ===

export interface WarehouseOrder {
  id: string;
  workspace_id: string;
  org_id: string;
  external_order_id: string | null;
  order_number: string | null;
  bandcamp_payment_id: number | null;
  customer_name: string | null;
  customer_email: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  total_price: number | null;
  currency: string;
  line_items: Record<string, unknown>[];
  shipping_address: Record<string, unknown> | null;
  tags: string[];
  is_preorder: boolean;
  street_date: string | null;
  source: OrderSource;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface WarehouseOrderItem {
  id: string;
  order_id: string;
  workspace_id: string;
  sku: string;
  quantity: number;
  price: number | null;
  title: string | null;
  variant_title: string | null;
  shopify_line_item_id: string | null;
  created_at: string;
}

export interface WarehouseShipment {
  id: string;
  workspace_id: string;
  org_id: string;
  shipstation_shipment_id: string | null;
  order_id: string | null;
  bandcamp_payment_id: number | null;
  bandcamp_synced_at: string | null;
  tracking_number: string | null;
  carrier: string | null;
  service: string | null;
  ship_date: string | null;
  delivery_date: string | null;
  status: string;
  shipping_cost: number | null;
  weight: number | null;
  dimensions: Record<string, unknown> | null;
  label_data: Record<string, unknown> | null;
  voided: boolean;
  billed: boolean;
  created_at: string;
  updated_at: string;
}

export interface WarehouseShipmentItem {
  id: string;
  shipment_id: string;
  workspace_id: string;
  sku: string;
  quantity: number;
  product_title: string | null;
  variant_title: string | null;
  created_at: string;
}

export interface WarehouseTrackingEvent {
  id: string;
  shipment_id: string;
  workspace_id: string;
  status: string;
  description: string | null;
  location: string | null;
  event_time: string | null;
  source: string | null;
  created_at: string;
}

// === Billing ===

export interface WarehouseBillingRule {
  id: string;
  workspace_id: string;
  rule_name: string;
  rule_type: "per_shipment" | "per_item" | "storage" | "material" | "adjustment";
  amount: number;
  description: string | null;
  is_active: boolean;
  effective_from: string;
  created_at: string;
}

export interface WarehouseFormatCost {
  id: string;
  workspace_id: string;
  format_name: string;
  format_key: string | null;
  display_name: string | null;
  pick_pack_cost: number;
  material_cost: number;
  cost_breakdown: Record<string, number>;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface WarehouseBillingRuleOverride {
  id: string;
  workspace_id: string;
  org_id: string;
  rule_id: string;
  override_amount: number;
  effective_from: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseFormatRule {
  id: string;
  workspace_id: string;
  format_pattern: string;
  format_name: string;
  priority: number;
  created_at: string;
}

export interface WarehouseBillingSnapshot {
  id: string;
  workspace_id: string;
  org_id: string;
  billing_period: string;
  snapshot_data: Record<string, unknown>;
  grand_total: number;
  total_shipping: number | null;
  total_pick_pack: number | null;
  total_materials: number | null;
  total_storage: number | null;
  total_adjustments: number | null;
  stripe_invoice_id: string | null;
  status: "draft" | "sent" | "paid" | "overdue" | "void";
  created_at: string;
}

export interface WarehouseBillingAdjustment {
  id: string;
  workspace_id: string;
  org_id: string;
  billing_period: string;
  amount: number;
  reason: string | null;
  created_by: string | null;
  snapshot_id: string | null;
  created_at: string;
}

// === Inbound ===

export interface WarehouseInboundShipment {
  id: string;
  workspace_id: string;
  org_id: string;
  tracking_number: string | null;
  carrier: string | null;
  expected_date: string | null;
  actual_arrival_date: string | null;
  status: InboundStatus;
  notes: string | null;
  submitted_by: string | null;
  checked_in_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseInboundItem {
  id: string;
  inbound_shipment_id: string;
  workspace_id: string;
  sku: string;
  expected_quantity: number;
  received_quantity: number | null;
  condition_notes: string | null;
  location_id: string | null;
  created_at: string;
  updated_at: string;
}

// === Bandcamp ===

export interface BandcampCredentials {
  id: string;
  workspace_id: string;
  client_id: string;
  client_secret: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BandcampConnection {
  id: string;
  workspace_id: string;
  org_id: string;
  band_id: number;
  band_name: string | null;
  band_url: string | null;
  is_active: boolean;
  member_bands_cache: Record<string, unknown> | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BandcampProductMapping {
  id: string;
  workspace_id: string;
  variant_id: string;
  bandcamp_item_id: number | null;
  bandcamp_item_type: "album" | "package" | "track" | null;
  bandcamp_member_band_id: number | null;
  bandcamp_type_name: string | null;
  bandcamp_new_date: string | null;
  bandcamp_url: string | null;
  last_quantity_sold: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

// === Monitoring ===

export interface WarehouseReviewQueue {
  id: string;
  workspace_id: string;
  org_id: string | null;
  category: string;
  severity: ReviewSeverity;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  status: ReviewStatus;
  assigned_to: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  sla_due_at: string | null;
  suppressed_until: string | null;
  group_key: string | null;
  occurrence_count: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: string;
  workspace_id: string | null;
  platform: string;
  external_webhook_id: string;
  topic: string | null;
  status: string;
  processed_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ChannelSyncLog {
  id: string;
  workspace_id: string;
  channel: string;
  sync_type: string | null;
  status: "started" | "completed" | "partial" | "failed";
  items_processed: number;
  items_failed: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface SensorReading {
  id: string;
  workspace_id: string;
  sensor_name: string;
  status: "healthy" | "warning" | "critical";
  value: Record<string, unknown> | null;
  message: string | null;
  created_at: string;
}

// === Support ===

export interface SupportConversation {
  id: string;
  workspace_id: string;
  org_id: string;
  subject: string;
  status: ConversationStatus;
  priority: "low" | "normal" | "high" | "urgent";
  assigned_to: string | null;
  inbound_email_id: string | null;
  created_by: string | null;
  client_last_read_at: string | null;
  staff_last_read_at: string | null;
  last_staff_escalated_at: string | null;
  last_client_reminded_at: string | null;
  source_channel: SupportSourceChannel;
  category: string | null;
  tags: string[];
  snoozed_until: string | null;
  first_response_due_at: string | null;
  first_responded_at: string | null;
  next_response_due_at: string | null;
  resolution_due_at: string | null;
  sla_policy_id: string | null;
  sla_breached_at: string | null;
  sla_paused: boolean;
  sla_paused_at: string | null;
  sla_pause_reason: string | null;
  sla_accumulated_pause_duration: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_code: string | null;
  resolution_summary: string | null;
  external_thread_id: string | null;
  external_order_id: string | null;
  external_customer_handle: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupportMessage {
  id: string;
  conversation_id: string;
  workspace_id: string;
  sender_id: string | null;
  sender_type: "staff" | "client" | "system";
  source: "app" | "email";
  source_channel: SupportSourceChannel | null;
  direction: SupportMessageDirection | null;
  external_message_id: string | null;
  client_mutation_id: string | null;
  delivered_via_email: boolean;
  body: string;
  email_message_id: string | null;
  attachments: Record<string, unknown>[];
  created_at: string;
}

export interface SupportMessageDelivery {
  id: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  channel: SupportDeliveryChannel;
  recipient: string | null;
  provider: string | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  status: "pending" | "queued" | "sent" | "delivered" | "failed" | "skipped";
  attempt_count: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupportEmailMapping {
  id: string;
  workspace_id: string;
  email_address: string;
  org_id: string;
  is_active: boolean;
  created_at: string;
}

// === Store Connections ===

export interface ClientStoreConnection {
  id: string;
  workspace_id: string;
  org_id: string;
  platform: StorePlatform;
  store_url: string;
  api_key: string | null;
  api_secret: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  connection_status: ConnectionStatus;
  last_webhook_at: string | null;
  last_poll_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  do_not_fanout: boolean;
  // HRD-05 — staff-selected default Shopify location for inventory ops.
  // Inventory webhooks with location_id !== this value are persisted as
  // status='wrong_location' and not applied. Migration 20260422000001.
  default_location_id: string | null;
  // HRD-35 — per-connection Shopify Custom-distribution app credentials.
  // NULL when the connection still uses the legacy single-app env fallback.
  shopify_app_client_id: string | null;
  // Plaintext today; column name is forward-compatible with the deferred
  // encryption-at-rest work (slug `client-store-credentials-at-rest-encryption`).
  shopify_app_client_secret_encrypted: string | null;
  // Phase 3 D1 — cutover state machine. See `CutoverState` for semantics.
  cutover_state: CutoverState;
  cutover_started_at: string | null;
  cutover_completed_at: string | null;
  shadow_mode_log_id: string | null;
  // Phase 3 D2 — per-connection override of the default 60s shadow-mode
  // comparison window. NULL = use default. Bounded 30..600 at the DB.
  shadow_window_tolerance_seconds: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Phase 3 D2 — `connection_shadow_log` row. The "what we'd push" half is
 * persisted synchronously by the shadow-mode write hook; the "what SS
 * actually pushed" half is filled in by the 60s-delayed
 * `shadow-mode-comparison` Trigger task. `match` and `drift_units` are
 * therefore both nullable — they become non-null only after the comparison
 * task runs.
 */
export interface ConnectionShadowLog {
  id: string;
  workspace_id: string;
  connection_id: string;
  correlation_id: string;
  sku: string;
  pushed_quantity: number;
  pushed_at: string;
  ss_observed_quantity: number | null;
  observed_at: string | null;
  match: boolean | null;
  drift_units: number | null;
  cutover_state_at_push: CutoverState;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Phase 3 D4 — per-connection echo override row. Presence of an active
 * row with `override_type='exclude_from_v2_echo'` means the connection's
 * storefront events fanout to v2 even though they would otherwise be in
 * the static echo-skip set.
 */
export interface ConnectionEchoOverride {
  id: string;
  connection_id: string;
  override_type: ConnectionEchoOverrideType;
  created_by: string | null;
  reason: string | null;
  created_at: string;
  is_active: boolean;
  /** Phase 3 Pass 2 D4: structured diagnostics snapshot at runConnectionCutover()
   *  time (counters, gate, window) + initiator user id + force_reason when applicable.
   *  Migration `20260427000003_connection_echo_overrides_metadata.sql`. */
  metadata: Record<string, unknown>;
}

export interface ClientStoreSkuMapping {
  id: string;
  workspace_id: string;
  connection_id: string;
  variant_id: string;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_inventory_item_id: string | null;
  remote_sku: string | null;
  last_pushed_quantity: number | null;
  last_pushed_at: string | null;
  is_active: boolean;
  match_method: string | null;
  match_confidence: string | null;
  matched_at: string | null;
  matched_by: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  deactivation_reason: string | null;
  candidate_fingerprint: string | null;
  // Phase 5 §9.6 D1 — per-channel safety stock (smallint, CHECK >= 0).
  // Migration 20260424000001_per_channel_safety_stock.sql. Reduces effective
  // sellable before push (see src/lib/server/effective-sellable.ts).
  safety_stock: number;
  // Phase 5 §9.6 D2 — per-SKU exemption from the daily shopify-policy-audit
  // DENY check. SKUs with preorder_whitelist=true may legitimately have
  // inventoryPolicy=CONTINUE on Shopify (so customers can backorder).
  preorder_whitelist: boolean;
  // Phase 5 §9.6 D2 — last observed Shopify variant inventoryPolicy
  // (DENY|CONTINUE). NULL = never audited. Updated by shopify-policy-audit.
  last_inventory_policy: string | null;
  // Phase 5 §9.6 D2 — wall-clock of the last shopify-policy-audit
  // observation. NULL = never audited.
  last_policy_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkuMappingEvent {
  id: string;
  workspace_id: string;
  mapping_id: string | null;
  connection_id: string;
  variant_id: string;
  canonical_sku: string | null;
  remote_sku: string | null;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_inventory_item_id: string | null;
  event_type: string;
  match_method: string | null;
  match_confidence: string | null;
  match_reasons: string[] | null;
  candidate_snapshot: Record<string, unknown> | null;
  candidate_fingerprint: string | null;
  actor_id: string | null;
  actor_role: string | null;
  notes: string | null;
  deactivation_reason: string | null;
  created_at: string;
}

/**
 * Phase 5 §9.6 D1 — per-(workspace, variant, channel) safety stock for
 * NON-storefront channels. Storefront channels live on
 * `client_store_sku_mappings.safety_stock` (one row per connection-SKU).
 * `channel` is open-enum text — known values today: `bandcamp`,
 * `clandestine_shopify`. The §9.6 push helper enforces the canonical set
 * at read time. Migration `20260424000001_per_channel_safety_stock.sql`.
 */
export interface WarehouseSafetyStockPerChannel {
  id: string;
  workspace_id: string;
  variant_id: string;
  channel: string;
  safety_stock: number;
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Phase 5 §9.6 D2 — append-only audit trail for every safety_stock or
 * preorder_whitelist edit made through the admin Safety Stock workspace.
 * Migration `20260427000004_safety_stock_audit_log.sql`. Staff-only RLS.
 */
export type SafetyStockAuditChannelKind = "storefront" | "internal";
export type SafetyStockAuditSource = "ui_inline" | "ui_bulk" | "ui_csv" | "system";

export interface WarehouseSafetyStockAuditLog {
  id: string;
  workspace_id: string;
  channel_kind: SafetyStockAuditChannelKind;
  connection_id: string | null;
  channel_name: string | null;
  variant_id: string | null;
  sku: string;
  prev_safety_stock: number | null;
  new_safety_stock: number;
  prev_preorder_whitelist: boolean | null;
  new_preorder_whitelist: boolean | null;
  reason: string | null;
  source: SafetyStockAuditSource;
  changed_by: string | null;
  changed_at: string;
}

// === Operational ===

export interface WarehouseShipstationStore {
  id: string;
  workspace_id: string;
  org_id: string | null;
  store_id: number;
  store_name: string | null;
  marketplace_name: string | null;
  created_at: string;
}

export interface WarehousePirateShipImport {
  id: string;
  workspace_id: string;
  file_name: string;
  storage_path: string | null;
  status: "pending" | "processing" | "completed" | "failed";
  row_count: number | null;
  processed_count: number;
  error_count: number;
  // Polymorphic JSONB — two runtime shapes:
  //   success → { per_row_errors: [...], metrics: {...}, trigger_run_id?: string }
  //   failure → [{ phase: string; message: string; timestamp: string; trigger_run_id?: string }]
  // Always read via parseImportErrors() in the UI — never treat as plain array.
  errors: unknown;
  uploaded_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface WarehouseSyncState {
  id: string;
  workspace_id: string;
  sync_type: string;
  last_sync_cursor: string | null;
  last_sync_wall_clock: string | null;
  last_full_sync_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
