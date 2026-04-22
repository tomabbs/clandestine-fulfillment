# Shopify Webhook Pre-Change Baseline (Workspace-First)

Captured at: `2026-04-20T20:28:52.251Z`

Purpose: freeze pre-implementation evidence for the workspace-first stabilization pass.

## Core Findings

- `warehouse_product_variants` coverage for `shopify_inventory_item_id` is high (`1588/1596`, `99.5%`).
- Recent webhook `inventory_item_id` values do not match our variant linkage (`0/484`, `0%`) in the last 3 days.
- Shopify `inventory_levels/update` events are arriving without tenant attribution:
  - 1 day: `396/396` rows with `workspace_id = null` (`100%`)
  - 3 days: `504/504` rows with `workspace_id = null` (`100%`)
  - 14 days: `602/602` rows with `workspace_id = null` (`100%`)

This confirms the first-order failure is ingress workspace attribution, with `sku_not_found` as a downstream symptom.

## Status Distribution Snapshot

### 1-day window

- total: `396`
- statuses:
  - `sku_not_found`: `396`

### 3-day window

- total: `504`
- statuses:
  - `sku_not_found`: `499`
  - `pending`: `5`

### 14-day window

- total: `602`
- statuses:
  - `sku_not_found`: `552`
  - `pending`: `50`

## Severity Buckets (Pre-Change)

- `S0` (critical): `workspace_id = null` on Shopify inventory webhooks.
  - Current rate: `100%` in 1d/3d/14d windows.
- `S1` (high): `sku_not_found` generated while `workspace_id` is null.
  - Current count: `552` in 14d window.
- `S2` (monitor): `pending` backlog for same topic.
  - Current count: `50` in 14d window.

## Sample Rows (Pre-Change)

- `299fab18-61db-4b6d-88e0-cb70ee7ec23e` — status `sku_not_found`, `workspace_id = null`, `inventory_item_id = 52009702949179`, `available = 0`
- `8e148dda-74e0-4188-ae51-e7dc6b48b326` — status `sku_not_found`, `workspace_id = null`, `inventory_item_id = 51935440077115`, `available = 61`
- `99a2fca9-29c3-4e9b-9c43-312b7da52dbe` — status `sku_not_found`, `workspace_id = null`, `inventory_item_id = 53180112142651`, `available = 995`

## Query Scope Used

- Source table: `webhook_events`
- Filter: `platform='shopify' AND topic='inventory_levels/update'`
- Time windows: 1 day, 3 days, 14 days
- Linkage check source table: `warehouse_product_variants`

