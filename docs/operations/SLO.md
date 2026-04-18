# Service-Level Objectives (SLOs) and Service-Level Indicators (SLIs)

> Tier 1 hardening (Part 14.7) item #5.
> Defines the explicit, measurable health bar for the Clandestine
> Fulfillment platform. "Is the system healthy?" is no longer opinion-based.

## Purpose

These SLOs anchor:
- **Alerting** — on-call gets paged when an SLI breaches its objective.
- **Release gating** — Phase 4+ rollouts pause if SLOs are degraded.
- **Operational reviews** — the daily reconciliation report
  (`daily-recon-summary` task) compares yesterday's SLI values against
  these objectives and flags red lines.
- **Customer trust** — what we publish on the status page (Tier 1 #10)
  must match these definitions.

## Reading the table

- **SLI**: the metric we measure.
- **Window**: time period the objective applies over.
- **Target**: the SLO — what we promise.
- **Source**: where the raw signal comes from.

---

## Critical-path SLOs (must hold at all times)

| # | SLI | Window | Target | Source |
|---|-----|--------|--------|--------|
| 1 | Webhook receive → 200 OK latency (Shopify, ShipStation, Resend, Stripe) | rolling 1h | p99 < 500ms | Sentry transaction p99 (Tier 1 #4 spans), Vercel access logs |
| 2 | Webhook 5xx rate (any provider) | rolling 1h | < 1% of requests | Vercel logs + Sentry error rate |
| 3 | `recordInventoryChange()` end-to-end (Redis + Postgres txn + ledger) | rolling 1h | p99 < 5s | Sentry span `inventory.record_change` |
| 4 | `recordInventoryChange()` → fanout dispatch latency (this is the visible "did Bandcamp update?" question for staff) | rolling 1h | p99 < 30s | Sentry span `inventory.fanout` |
| 5 | Phase 4 SHIP_NOTIFY → Bandcamp `update_quantities` end-to-end | rolling 24h | p99 < 60s, p95 < 30s | `external_sync_events.completed_at - started_at` for `system='bandcamp'` action='adjust' |
| 6 | Bandcamp queue starvation (queued tasks waiting > N min) | rolling 1h | < 5 min queue depth wait p95 | Trigger.dev queue metrics, `bandcamp-api` queue |

## Reconciliation SLOs (must hold daily)

| # | SLI | Window | Target | Source |
|---|-----|--------|--------|--------|
| 7 | Inventory drift items detected (`warehouse_review_queue.category='bundle.derived_drift'` or `inventory.*`) | rolling 24h | < 10 new items per workspace | `warehouse_review_queue` rows added in window |
| 8 | `external_sync_events.status='error'` rate (per system) | rolling 24h | < 0.5% of total ledger rows | `external_sync_events` GROUP BY system |
| 9 | Channel sync failure rate (`channel_sync_log.status='failed'`) | rolling 24h | < 5% of runs per channel | `channel_sync_log` |
| 10 | Bandcamp scraper success rate (Rule #35) | rolling 24h | > 80% per workspace | `channel_sync_log` rows for `bandcamp-scrape-*` |

## Availability SLOs

| # | SLI | Window | Target | Source |
|---|-----|--------|--------|--------|
| 11 | Vercel app uptime (admin + portal + webhooks) | rolling 30d | 99.9% | Synthetic monitoring (Tier 1 #9) |
| 12 | Supabase Postgres availability | rolling 30d | 99.95% | Supabase status page |
| 13 | Trigger.dev cron execution success rate | rolling 30d | > 99% per scheduled task | Trigger.dev dashboard |

## Webhook delivery SLO

| # | SLI | Window | Target | Source |
|---|-----|--------|--------|--------|
| 14 | Per-platform webhook silence (Rule #17) — `client_store_connections.last_webhook_at < now() - 6h` | rolling check, every 5 min | 0 connections in violation OR auto-flagged to review queue | `sensor_check` task + `webhook_silence` sensor |

---

## Alert thresholds (paging)

A page goes to on-call when:

- Any **Critical-path SLO** misses target for two consecutive 1h windows.
- Any **Reconciliation SLO** misses for two consecutive 24h windows.
- Bandcamp queue starvation > 15 min p95 (urgent — Rule #9 risk).
- ShipStation v2 push error rate > 5% in 1h (urgent — Phase 4 stability).

A non-paging Slack alert when:

- Bandcamp scraper success rate drops below 80% but stays above 50%.
- `external_sync_events.error` count > 3x rolling 7-day mean.
- Any single workspace has > 25 open `warehouse_review_queue` items
  (operator visibility, not user-facing impact).

## Where the report lives

The `daily-recon-summary` task (Tier 1 #11) produces a daily snapshot of
SLOs 7-9 and emails to `OPS_ALERT_EMAIL`. SLOs 1-6 require Sentry
dashboards (manually maintained — link in `docs/operations/runbooks/sentry-dashboards.md`).

## Maintenance

Update this document when:

- A new integration ships with measurable end-to-end latency
  (add a critical-path row).
- An incident reveals an SLI we should have been tracking
  (post-mortem Action Item).
- Phase gates 4+ require new acceptance criteria
  (Phase closeout updates here).

Date of last review: 2026-04-13 (initial creation, Tier 1 hardening pass).
