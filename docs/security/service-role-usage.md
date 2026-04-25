# Service-role usage manifest

> Tier 1 hardening (Part 14.7) item #2.
> `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — every callsite must be justified
> in writing. New callsites without a manifest entry fail CI
> (`scripts/check-service-role-usage.sh`).

## How to update

When you add a new file that calls `createServiceRoleClient()`:

1. Add the file path to the appropriate category below with a one-line
   justification. Re-use an existing category when possible.
2. If the call is inside a Server Action, confirm the action enforces
   `requireAuth + isStaff/isClient` BEFORE the service-role call. Note any
   exception in the entry.
3. Run `bash scripts/check-service-role-usage.sh` locally to confirm the
   manifest count matches the codebase count.
4. Commit the manifest update in the same PR as the new callsite.

## Counting rule

The CI guard counts unique source files (under `src/`) that grep positive
for `createServiceRoleClient`. Test files are excluded by the script.

## Categories

### A. The helper itself (1 file)

- `src/lib/server/supabase-server.ts` — defines `createServiceRoleClient()`.
  This is the only file that imports `SUPABASE_SERVICE_ROLE_KEY` directly.

### B. Trigger.dev tasks — Rule #7 mandates service-role here (61 files)

Trigger tasks run with no user session and must bypass RLS. Every task in
this list operates against `workspace_id`-scoped data — RLS would deny all
operations because the task has no authenticated `auth.uid()`.

- `src/trigger/tasks/aftership-register.ts` — register tracking webhooks.
- `src/trigger/tasks/bandcamp-baseline-audit.ts` — Phase 1 audit cron, writes `bandcamp_baseline_anomalies`.
- `src/trigger/tasks/bandcamp-inventory-push.ts` — fanout to Bandcamp API.
- `src/trigger/tasks/bandcamp-mark-shipped.ts` — confirm shipment in Bandcamp.
- `src/trigger/tasks/bandcamp-order-sync.ts` — pull Bandcamp orders.
- `src/trigger/tasks/bandcamp-sale-poll.ts` — backup poller for sales.
- `src/trigger/tasks/bandcamp-sales-backfill.ts` — bulk historical pull.
- `src/trigger/tasks/bandcamp-sales-sync.ts` — daily sales sync.
- `src/trigger/tasks/bandcamp-scrape-sweep.ts` — scrape queue runner.
- `src/trigger/tasks/bandcamp-sync.ts` — full catalog sync.
- `src/trigger/tasks/bandcamp-tag-backfill.ts` — backfill genre tags.
- `src/trigger/tasks/bundle-availability-sweep.ts` — recompute bundle availability.
- `src/trigger/tasks/bundle-component-fanout.ts` — fanout components on bundle change.
- `src/trigger/tasks/bundle-derived-drift.ts` — Phase 2.5(c) sensor, writes review queue.
- `src/trigger/tasks/catalog-stats-refresh.ts` — refresh catalog stats snapshot.
- `src/trigger/tasks/clandestine-shopify-sync.ts` — Phase 0.7 distro seeder.
- `src/trigger/tasks/client-store-order-detect.ts` — order poller.
- `src/trigger/tasks/create-shipping-label.ts` — EasyPost label creation.
- `src/trigger/tasks/daily-recon-summary.ts` — Tier 1 #11 daily report.
- `src/trigger/tasks/debug-env.ts` — debug helper, dev only.
- `src/trigger/tasks/discogs-catalog-match.ts` — Discogs master catalog match.
- `src/trigger/tasks/discogs-client-order-sync.ts` — Discogs client order pull.
- `src/trigger/tasks/discogs-initial-listing.ts` — Discogs first-listing.
- `src/trigger/tasks/discogs-listing-replenish.ts` — Discogs replenish.
- `src/trigger/tasks/discogs-mailorder-sync.ts` — Discogs mail-order pull.
- `src/trigger/tasks/discogs-message-poll.ts` — Discogs inbox poller.
- `src/trigger/tasks/discogs-message-send.ts` — Discogs message send.
- `src/trigger/tasks/external-sync-events-retention.ts` — Tier 1 #14 retention sweep.
- `src/trigger/tasks/generate-daily-scan-form.ts` — daily scan form export.
- `src/trigger/tasks/inbound-checkin-complete.ts` — inbound check-in completion.
- `src/trigger/tasks/inbound-product-create.ts` — create product from inbound.
- `src/trigger/tasks/mailorder-shopify-sync.ts` — mail-order Shopify pull.
- `src/trigger/tasks/mark-mailorder-fulfilled.ts` — mark mail-order shipped.
- `src/trigger/tasks/mark-platform-fulfilled.ts` — mark platform-side fulfilled.
- `src/trigger/tasks/monthly-billing.ts` — Rule #22 billing snapshot.
- `src/trigger/tasks/multi-store-inventory-push.ts` — fanout to client stores.
- `src/trigger/tasks/oauth-state-cleanup.ts` — clean expired oauth_states.
- `src/trigger/tasks/pirate-ship-import.ts` — XLSX import.
- `src/trigger/tasks/preorder-fulfillment.ts` — FIFO preorder release (Rule #69).
- `src/trigger/tasks/preorder-setup.ts` — preorder setup from sync.
- `src/trigger/tasks/process-client-store-webhook.ts` — webhook processor.
- `src/trigger/tasks/process-shipstation-shipment.ts` — Phase 2 SHIP_NOTIFY processor.
- `src/trigger/tasks/process-shopify-webhook.ts` — Shopify webhook processor.
- `src/trigger/tasks/redis-backfill.ts` — Postgres → Redis projection rebuild (Rule #27).
- `src/trigger/tasks/scraper-reconcile.ts` — 6h scraper reconciliation.
- `src/trigger/tasks/sensor-check.ts` — periodic sensor evaluations.
- `src/trigger/tasks/shipstation-poll.ts` — backup poll (bridge until Shopify approval).
- `src/trigger/tasks/shipstation-seed-inventory.ts` — Phase 3 v2 seed.
- `src/trigger/tasks/shipstation-store-refresh.ts` — Phase 3 v1 store refresh stub.
- `src/trigger/tasks/shopify-full-backfill.ts` — Rule #59 bulk backfill.
- `src/trigger/tasks/shopify-image-backfill.ts` — image backfill.
- `src/trigger/tasks/shopify-order-sync.ts` — Shopify order pull.
- `src/trigger/tasks/shopify-sync.ts` — Rule #59 incremental sync.
- `src/trigger/tasks/sku-rectify-via-alias.ts` — alias-based SKU repair.
- `src/trigger/tasks/sku-sync-audit.ts` — SKU drift audit cron.
- `src/trigger/tasks/storage-calc.ts` — storage fee compute.
- `src/trigger/tasks/support-escalation.ts` — support escalation cron.
- `src/trigger/tasks/support-message-delivery.ts` — support delivery ledger sends + retry recovery.
- `src/trigger/tasks/tag-cleanup-backfill.ts` — admin-triggered tag cleanup.
- `src/trigger/tasks/weekly-backup-verify.ts` — Tier 1 #8 backup probe.

### C. Trigger.dev shared lib (3 files)

Helpers imported by the tasks above. Service-role flows downstream from
the task entry point.

- `src/trigger/lib/format-detection.ts` — format heuristics with DB lookups.
- `src/trigger/lib/match-shipment-org.ts` — match shipment to org via DB.
- `src/trigger/lib/materials-cost.ts` — read materials catalog.

### D. Webhook + OAuth Route Handlers (10 files)

Public-facing endpoints with no user session — verified via HMAC / OAuth
state instead.

- `src/app/api/oauth/discogs/route.ts` — Discogs OAuth start (state row).
- `src/app/api/oauth/shopify/route.ts` — Shopify OAuth callback.
- `src/app/api/oauth/squarespace/route.ts` — Squarespace OAuth start.
- `src/app/api/oauth/woocommerce/callback/route.ts` — WooCommerce OAuth callback.
- `src/app/api/oauth/woocommerce/route.ts` — WooCommerce OAuth start.
- `src/app/api/webhooks/resend-inbound/route.ts` — Resend inbound (Svix-verified).
- `src/app/api/webhooks/shipstation/route.ts` — SHIP_NOTIFY ingress.
- `src/app/api/webhooks/shopify/gdpr/customers-data-request/route.ts` — GDPR request.
- `src/app/api/webhooks/shopify/gdpr/customers-redact/route.ts` — GDPR redact.
- `src/app/api/webhooks/shopify/gdpr/route.ts` — GDPR top-level.
- `src/app/api/webhooks/shopify/gdpr/shop-redact/route.ts` — GDPR shop redact.
- `src/app/api/webhooks/shopify/route.ts` — Shopify webhook ingress.

### E. Server Actions — service-role gated by `requireAuth + isStaff` (28 files)

Server Actions with explicit auth+role enforcement BEFORE the
service-role call. Pattern: `await requireAuth(); if (!isStaff(user)) throw …;`
then `const sb = createServiceRoleClient();`. Service-role is used only
when the action needs to bypass RLS for cross-org reads (admin views) or
to write under the workspace's enforced trigger pipeline.

- `src/actions/auth.ts` — sign-in helpers (look up users.users by email).
- `src/actions/bandcamp-baseline.ts` — Phase 1 baseline mark/unmark.
- `src/actions/bandcamp-shipping.ts` — bulk shipping rate import.
- `src/actions/bandcamp.ts` — Bandcamp admin actions.
- `src/actions/billing.ts` — staff billing edits / debug.
- `src/actions/bundle-components.ts` — bundle catalog mgmt.
- `src/actions/catalog.ts` — staff catalog edits.
- `src/actions/client-store-credentials.ts` — Rule #19 service-role credential write.
- `src/actions/clients.ts` — client mgmt.
- `src/actions/discogs-admin.ts` — Discogs admin actions.
- `src/actions/inbound.ts` — inbound mgmt.
- `src/actions/inventory.ts` — staff inventory edits.
- `src/actions/mail-orders.ts` — mail-order admin.
- `src/actions/orders.ts` — order admin.
- `src/actions/organizations.ts` — org admin.
- `src/actions/portal-dashboard.ts` — portal dashboard reads (cross-org join via service-role; gated by client auth).
- `src/actions/portal-sales.ts` — portal sales read (gated by client auth).
- `src/actions/portal-settings.ts` — portal settings (gated by client auth).
- `src/actions/portal-stores.ts` — Phase 0.8 hidden but still gated.
- `src/actions/product-images.ts` — image upload management.
- `src/actions/reports.ts` — report exports.
- `src/actions/shipping.ts` — shipping admin.
- `src/actions/shipstation-seed.ts` — Phase 3 staff-only.
- `src/actions/sku-conflicts.ts` — Phase 0.5 admin queue.
- `src/actions/store-connections.ts` — Phase 0.8 reactivate.
- `src/actions/store-mapping.ts` — store-mapping admin.
- `src/actions/support.ts` — support agent actions.
- `src/actions/users.ts` — user mgmt.

### F. Server libs that take a workspace_id (6 files)

Library helpers that themselves create the service-role client. Each is
called from one of the categories above and inherits that auth check.

- `src/lib/clients/bandcamp.ts` — Bandcamp API client (token refresh DB write).
- `src/lib/server/auth-context.ts` — looks up `users` row by `auth.uid()`.
- `src/lib/server/bandcamp-shipping-paid.ts` — read shipping-paid map.
- `src/lib/server/bundles.ts` — bundle availability helper (used by tasks + actions).
- `src/lib/server/inventory-fanout.ts` — Rule #43 fanout step.
- `src/lib/server/record-inventory-change.ts` — Rule #20 single inventory write path.

## Audit cadence

This manifest must be reviewed at every Tier 1 audit pass (currently:
Phase 4 closeout). The CI guard prevents drift between audits.

## Known service-role principles violated (none)

If we ever need to ship a service-role usage that does NOT have an auth
check upstream, document it here with the reason and the compensating
control.

- _none currently_
