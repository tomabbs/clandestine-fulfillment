# Operations Runbook

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
