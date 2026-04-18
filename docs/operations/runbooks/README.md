# Operational runbooks

> Tier 1 hardening (Part 14.7) item #12.
> One runbook per Trigger.dev task. Each runbook follows
> [`_template.md`](./_template.md).

## Index

### Bandcamp

- [`bandcamp-sync`](./bandcamp-sync.md) — full Bandcamp catalog sync
- [`bandcamp-sale-poll`](./bandcamp-sale-poll.md) — backup sales poller
- [`bandcamp-inventory-push`](./bandcamp-inventory-push.md) — push inventory to Bandcamp
- [`bandcamp-mark-shipped`](./bandcamp-mark-shipped.md) — confirm shipment to Bandcamp
- [`bandcamp-baseline-audit`](./bandcamp-baseline-audit.md) — Phase 1 baseline anomaly audit
- [`bandcamp-sales-backfill-cron`](./bandcamp-sales-backfill.md) — Sales API daily backfill
- [`bandcamp-scrape-sweep`](./bandcamp-scrape-sweep.md) — HTML scrape queue runner

### Shopify (Clandestine)

- [`shopify-sync`](./shopify-sync.md) — incremental Shopify sync (Rule #59)
- [`shopify-full-backfill`](./shopify-full-backfill.md) — full bulk backfill (Rule #59)
- [`process-shopify-webhook`](./process-shopify-webhook.md) — async webhook processor

### ShipStation

- [`shipstation-poll`](./shipstation-poll.md) — backup poller (bridge until Shopify approval)
- [`shipstation-seed-inventory`](./shipstation-seed-inventory.md) — Phase 3 v2 seed
- [`process-shipstation-shipment`](./process-shipstation-shipment.md) — SHIP_NOTIFY processor

### Inventory + bundles

- [`redis-backfill`](./redis-backfill.md) — Postgres → Redis projection rebuild (Rule #27)
- [`bundle-derived-drift-sensor`](./bundle-derived-drift.md) — Phase 2.5(c) sensor
- [`bundle-availability-sweep`](./bundle-availability-sweep.md) — recompute bundle availability

### Reconciliation + ops

- [`daily-recon-summary`](./daily-recon-summary.md) — Tier 1 #11 daily report
- [`weekly-backup-verify`](./weekly-backup-verify.md) — Tier 1 #8 backup probe (operator extension below)
- [`external-sync-events-retention`](./external-sync-events-retention.md) — Tier 1 #14 ledger retention
- [`sensor-check`](./sensor-check.md) — periodic sensor evaluations

### Operator-only procedures

- [`backup-verify`](./backup-verify.md) — full sandbox-restore procedure (operator extension to Tier 1 #8 task)
