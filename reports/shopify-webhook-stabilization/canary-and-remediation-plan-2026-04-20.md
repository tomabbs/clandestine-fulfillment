# Shopify Webhook Canary + Remediation Plan (Paused Sync)

Date: `2026-04-20`

## Operating Model

- First-party Shopify webhook ingress is **observe-only** for:
  - `inventory_levels/update`
  - `orders/create`
  - `orders/updated`
- ShipStation remains authoritative for order/inventory movement.
- Clandestine Shopify catalog/product sync remains Graph API task-driven.

## Canary Gates (Post-Deploy)

Run for 24h while `workspaces.inventory_sync_paused = true`:

1. **Workspace attribution gate**
   - `workspace_resolution_failed + workspace_ambiguous` <= 1% of Shopify inventory/order webhook traffic.
2. **Observe-only gate**
   - `ignored_shipstation_authoritative` should dominate for inventory/order topics.
3. **No side-effects gate**
   - No new `warehouse_inventory_activity` rows with `source='shopify'` caused by first-party webhook ingress.
4. **Stability gate**
   - No spike in `processing_failed` for Shopify webhook rows.

## Pre-Deploy Baseline Snapshot (14d)

- Shopify inventory/order webhook events: `605`
- Current statuses (legacy behavior): `sku_not_found=552`, `pending=53`
- `warehouse_inventory_activity` rows with `source='shopify'` in 14d: `1689`

Interpretation: this baseline reflects pre-change behavior. After deploy, new events should trend toward `ignored_shipstation_authoritative` for inventory/order topics, and new webhook-driven shopify inventory writes should stop.

## Verification Queries

Use:

- `reports/shopify-webhook-stabilization/observability-queries.sql`
- `scripts/sql/webhook_health_snapshot.sql`

## Remediation Manifest

### Scope

- **No inventory quantity remediation is executed in this phase.**
- Reason: first-party Shopify inventory/order webhooks are non-authoritative by design under ShipStation-first operations.

### Allowed Remediation

- Metadata/status normalization for webhook events only (if needed for clean dashboards).
- No writes to `warehouse_inventory_levels` and no external inventory fanout from these webhook topics.

## Rollback

If canary gates fail:

1. Keep observe-only mode (no re-enable of mutation path).
2. Continue recording resolver traces for diagnosis.
3. Investigate domain/tenant attribution mismatches before any mutation re-enable.
