# Operations Runbook

## Truth layer maintenance (required after behavior changes)

When a session changes system behavior, update truth docs in the same session:

1. `TRUTH_LAYER.md`
2. `project_state/engineering_map.yaml`
3. `project_state/journeys.yaml`
4. `docs/system_map/API_CATALOG.md` (if route/action boundary changed)
5. `docs/system_map/TRIGGER_TASK_CATALOG.md` (if async/task wiring changed)
6. `docs/RELEASE_GATE_CRITERIA.md` (if verification expectations changed)

Do not treat implementation as complete until this sync is done.

## billing_invoice_failed (Stripe payment failure)

**Trigger**: Stripe webhook `invoice.payment_failed` creates a review queue item with severity `high`.

1. Check the review queue for the item — note the org name and billing period
2. In Stripe dashboard, check the invoice status and payment method
3. Contact the client's billing email about the failed payment
4. If payment method updated, retry the invoice in Stripe
5. The webhook will update the snapshot status to `paid` when successful
6. Resolve the review queue item with resolution notes

## short_shipment (pre-order stock shortage)

**Trigger**: `preorder-fulfillment` task creates a critical review queue item when available stock < pre-order demand.

1. Check the review queue item metadata for SKU, available stock, and unallocated order count
2. Contact the pressing plant about the short shipment
3. Options:
   - Wait for remaining units to arrive (create inbound shipment)
   - Manually release partial allocation via admin dashboard
   - Contact affected customers about delays
4. When stock arrives, re-run the preorder-fulfillment task or use "Release Now"

## Force Redis backfill

```bash
# Via Trigger.dev dashboard: manually trigger "redis-backfill" task
# Or via API:
curl -X POST https://api.trigger.dev/api/v1/tasks/redis-backfill/trigger \
  -H "Authorization: Bearer $TRIGGER_SECRET_KEY"
```

The task runs weekly on Tuesday 3 AM EST automatically. It skips SKUs with live writes during the backfill window to prevent race conditions.

## Physical inventory baseline import window

**Trigger**: Quarterly/semiannual warehouse count or first inventory-sync cutover baseline.

Preferred path is a sales freeze for the target label/org while the count is taken and imported:

1. Keep `workspaces.inventory_sync_paused=true` and target connections at `do_not_fanout=true`.
2. Record `counted_at`, `import_started_at`, and `import_completed_at` in the operator log and import report notes.
3. Pause or hide purchase paths for the target label where practical before counting begins.
4. Run `scripts/import-inventory-master.ts --dry-run` and resolve rejects, especially duplicate SKUs, wrong workspace rows, active count sessions, and bundle-parent rows.
5. Apply with a stable `--cycle-id` and `--import-run-id`; every applied row uses `recordInventoryChange({ source:'baseline_import', fanout:{ suppress:true } })`.
6. Run the inventory sync preflight and spot checks before enabling any outbound fanout.

If sales cannot be frozen, do not treat the workbook as a complete final state by itself. Build a movement replay ledger for `[counted_at, imported_at]` plus a small overlap for late webhooks/polls. Reuse original source identities and correlation IDs for Shopify webhooks, Bandcamp sale polls, ShipStation shipment notifications, and label orders; check `warehouse_inventory_activity`, `webhook_events`, and `warehouse_orders` before replaying so partially processed movement cannot double-decrement. Bandcamp sale polling must either be paused for the target connection during import or included explicitly in the replay ledger.

WooCommerce stays out of v1 inventory-sync cutover unless its connection is mapped and passes the same readiness gates as Shopify. Deferred Woo connections must remain `do_not_fanout=true` and `cutover_state='legacy'`.

## Disable a broken client store connection

1. Go to Admin > Settings > Store Connections
2. Find the connection with errors
3. The circuit breaker auto-disables after 5 consecutive auth failures
4. To manually disable: update `connection_status` to `disabled_auth_failure` and `do_not_fanout` to `true`
5. To re-enable: fix the API credentials, set status back to `active` and `do_not_fanout` to `false`

## Add a new Bandcamp fulfillment account

1. Obtain OAuth client_id and client_secret from Bandcamp
2. Add credentials to `bandcamp_credentials` table
3. Create a `bandcamp_connections` row linking the band_id to the org
4. Run the `bandcamp-sync` task to import product data
5. Verify mappings in `bandcamp_product_mappings`
6. The `bandcamp-sale-poll` and `bandcamp-inventory-push` crons will handle ongoing sync

## Run a full Shopify backfill

1. Go to Admin > Channels
2. Click "Full Backfill" button
3. Monitor progress in the sync history table
4. The task fetches all products with pagination and upserts everything
5. After completion, verify product counts match Shopify

## Debug inventory drift (Redis vs Postgres)

1. Check Admin > Settings > Health for the `inv.redis_postgres_drift` sensor
2. If mismatches detected, review the sensor reading metadata for affected SKUs
3. Compare Redis values: check Upstash dashboard for `inv:{sku}` hash
4. Compare Postgres values: query `warehouse_inventory_levels` for the same SKU
5. If drift confirmed, run the Redis backfill task to rebuild Redis from Postgres
6. Check `warehouse_inventory_activity` for recent writes that may explain the drift
7. If persistent, check for code paths bypassing `recordInventoryChange()` — run `ci-inventory-guard.sh`
