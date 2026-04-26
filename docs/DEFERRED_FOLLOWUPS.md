---
- slug: tracking-notification-aftership-sunset
  title: "Sunset /api/webhooks/aftership in favor of /api/webhooks/easypost (tracking-notification hardening v5)"
  due_date: 2026-06-25
  severity: medium
  context: "Tracking-notification hardening v5 (2026-04-25) introduced /api/webhooks/easypost as the canonical tracking webhook with full HMAC v1+v2 verification (dual-secret rotation), `interpretDedupError`, append-only `notification_provider_events` ledger, and centralized status writes through `src/lib/server/notification-status.ts` (CI guard `scripts/check-notification-status-writes.sh`). The legacy /api/webhooks/aftership route is intentionally retained during a dual-mode window so the parity sensor `tracking.status_drift_24h` can verify both paths agree on `warehouse_shipments.easypost_tracker_status`. The aftership route still does a direct `warehouse_shipments.status` write that bypasses the wrapper — this is intentionally NOT flagged by the CI guard (which only protects `notification_sends.status` + `easypost_tracker_status`) so the legacy path can keep functioning during the sunset. Action at T+~60d: confirm `tracking.status_drift_24h` has reported zero divergence for ≥30 consecutive days; remove `src/app/api/webhooks/aftership/route.ts`, `src/trigger/tasks/aftership-register.ts`, and the AfterShip OAuth/credential surface; verify no production label-creation path enqueues `aftership-register` (only `easypost-register-tracker`). Ensure the `AFTERSHIP_*` env vars are removed from `pnpm ops:check-webhook-secrets`."
- slug: tracking-notification-status-write-guard-expansion
  title: "Expand check-notification-status-writes.sh to cover warehouse_shipments.status once aftership sunsets"
  due_date: 2026-06-25
  severity: low
  context: "scripts/check-notification-status-writes.sh today guards direct writes to `notification_sends.status` and `warehouse_shipments.easypost_tracker_status` outside the central wrapper at `src/lib/server/notification-status.ts`. It does NOT guard the more general `warehouse_shipments.status` column, because `/api/webhooks/aftership/route.ts` still writes it directly during the dual-mode sunset window (see tracking-notification-aftership-sunset). After the aftership route is removed, expand the guard regex to include `warehouse_shipments.status` as well, and add `updateShipmentStatusSafe()` (or equivalent) wrapper if any non-tracking code paths legitimately need to write `warehouse_shipments.status` — the goal is one centralized writer per status column."
- slug: phase5-d1b-bandcamp-commit-release
  title: "Phase 5 §9.6 D1.b extension — wire commit/release into Bandcamp + preorder + refund paths"
  due_date: 2026-05-22
  severity: medium
  context: "D1.b landed 2026-04-24 (migration 20260424000005_atp_committed_active_flag.sql + commitOrderItems()/releaseOrderItems() helpers). Wired into client-store webhooks (handleOrderCreated + handleOrderCancelled in src/trigger/tasks/process-client-store-webhook.ts) and the platform-fulfillment success path (src/trigger/tasks/mark-platform-fulfilled.ts every platform branch). DEFERRED in this pass: (1) Bandcamp sale-poll (src/trigger/tasks/bandcamp-sale-poll.ts) — the path packs +sold deltas, not a real order lifecycle; needs design pass on whether each Bandcamp sale = one logical commit-then-immediate-release vs only writing the recordInventoryChange decrement. (2) preorder-fulfillment (src/trigger/tasks/preorder-fulfillment.ts) — the FIFO allocator already mutates `available` directly per Rule #69; the commit ledger should mirror the allocation but the refactor needs care because partial short-shipments must release fewer than the full preorder qty. (3) Refund paths (whichever Server Action / webhook reverses an order) — currently no global refund handler; needs an audit. (4) Manual order Server Actions in src/actions/orders.ts — if any exist that bypass the webhook path. Companion: flip workspaces.atp_committed_active=true per workspace ONLY after this follow-up + the D1.b.1 decrement-at-fulfillment refactor land together (otherwise double-counts every order)."
- slug: phase5-d1b1-decrement-at-fulfillment-refactor
  title: "Phase 5 §9.6 D1.b.1 — refactor `available` to no longer decrement at orders/create (only at fulfillment)"
  due_date: 2026-06-30
  severity: high
  context: "Today, `warehouse_inventory_levels.available` decrements at orders/create (via recordInventoryChange when the webhook lands). With D1.b shipped, `committed_quantity` ALSO increments at orders/create. The double-write is intentional and gated by `workspaces.atp_committed_active boolean DEFAULT false` (migration 20260424000005) — when the flag is FALSE, computeEffectiveSellable() ignores committed_quantity, so the legacy semantic is preserved exactly. To flip the flag to TRUE and unlock real ATP semantics ('available' = on-hand truth, 'committed' = held-by-orders, 'sellable' = available - committed - safety), this refactor must: (1) STOP decrementing `available` in handleOrderCreated webhook paths; (2) START decrementing `available` only at fulfillment confirmation (mark-platform-fulfilled successful branch — the SAME place where releaseOrderItems is now called); (3) cancel paths revert nothing (no `available` change happened on create), only release the commit; (4) refund-after-ship recredits `available` (because fulfillment did decrement it) AND opens no new commit. Roll out per-workspace: refactor live, flip atp_committed_active=true workspace-by-workspace with shadow comparison + rollback. The D1.c recon (inventory-committed-counter-recon) catches any drift the refactor introduces."
# Phase 5 §9.6 D1.b/c COMPLETED 2026-04-24 — see TRUTH_LAYER.md "Phase 5 §9.6 D1.b/c — ATP wire-up + counter recon"
# - inventory-committed-counter-recon Trigger task lives at src/trigger/tasks/inventory-committed-counter-recon.ts
# - 8 unit tests at tests/unit/trigger/inventory-committed-counter-recon.test.ts (all pass)
# - Wire-up landed in process-client-store-webhook.ts + mark-platform-fulfilled.ts
# - workspaces.atp_committed_active flag added (migration 20260424000005) — DEFAULT false preserves legacy semantic
# - The original phase5-d1-wireup-orders-paths + phase5-d1-recon-counter-vs-ledger entries are RESOLVED
#   by the above; the two follow-up entries above (phase5-d1b-bandcamp-commit-release +
#   phase5-d1b1-decrement-at-fulfillment-refactor) capture the residual scope.
- slug: phase5-drop-legacy-committed-column
  title: "Phase 5 cleanup — drop legacy warehouse_inventory_levels.committed column"
  due_date: 2026-08-01
  severity: low
  context: "Phase 0 placeholder column `warehouse_inventory_levels.committed integer DEFAULT 0`. Audited 2026-04-24 (grep across src/**) confirmed it is never written non-zero anywhere in the codebase. Replaced by the new `committed_quantity` column added in migration 20260424000004_inventory_commitments.sql (paired with the inventory_commitments ledger). Action at T+~3mo: re-grep src/** + scripts/** for any new readers of `committed` (NOT `committed_quantity` — they're distinct names); if zero readers, drop in a one-line migration. Three months gives Phase 5 D1.b/c time to land and any dormant code paths to surface. Risk: low — the column carries `0` for every row so even a forgotten reader would see `available - 0 - safety_stock` and behave as before the column existed."
- slug: phase4-burst-run2-x1-close
  title: "Phase 4 Sub-pass A.2 — burst-test Run #2 (closes X-1 gate)"
  due_date: 2026-04-26
  severity: high
  context: "Run #1 captured 2026-04-24 against Northern Spy prod (cutover_state=legacy, do_not_fanout=true) — full report at reports/phase4-burst/2026-04-24T11-09-18-489Z-run1-summary.md. Plan §9.5 X-1 requires two consecutive burst-test runs ≥ 24h apart, both failing F-7 (cold-start ingress p95 < 800ms), before Phase 4 commits to building an Edge ingress. Run #1 failed F-7 with 200-only-path p95 = 1,507 ms (cold-start proxy p95 = 1,660 ms). Action for operator/agent: re-run scripts/_phase4-burst-test.ts --apply --scale=full --label=run2 in a low-traffic window (suggested 03:00 UTC), then run scripts/_phase4-burst-cleanup.ts --apply --run-id={run2_id} immediately after. Write reports/phase4-burst/{ts}-run2-summary.md and reports/phase4-burst/X-1-decision.md combining both runs. If Run #2 also fails F-7, the X-1 gate fires and Phase 4 build is approved. If Run #2 passes (within 800 ms p95), the X-1 gate does NOT fire and Phase 4 stays deferred — both outcomes need the X-1-decision.md artifact for audit."
- slug: webhook-events-post-stabilization-stragglers
  title: "Investigate 5 residual `webhook_events.status='pending'` rows from 2026-04-21/22"
  due_date: 2026-04-30
  severity: low
  context: "Surfaced by Phase 4 X-1.b temporal-distribution audit (scripts/_phase4-x1b-temporal-distribution.ts, 2026-04-24). The 2026-04-20 webhook workspace-first stabilization successfully eliminated the parse_failed/pending fire (33,528 + 22,902 events between 2026-04-09 and 2026-04-20 dropped to ~0 from 2026-04-21 onward). However, 5 `pending` rows from 2026-04-21 and 2026-04-22 never completed processing — oldest is 83 hours stale at audit time. Sample external_webhook_ids: ed7def4b-601d-57e3-83dc-f6da297da974, 877b6a35-5a67-5068-8bb7-7557937ea19a, 0d28aa89-2e80-591f-9ab5-50a82b7e7763, c0342b41-bfda-5de0-adc3-51d2ae5c1eb2, b7d21fd7-5b4f-51f4-82c0-31cebe086dcd. All `platform=shopify`. Action: query webhook_events WHERE status='pending' AND created_at < now() - interval '1 hour' to enumerate the full set; investigate why the recovery sweep (`webhook-events-recovery-sweep` Trigger task, runs every 5min) did not retry them; either complete processing or mark as resolved/dropped. Likely a small bug in the recovery sweep's status filter or a race condition during the stabilization deploy. Not safety-critical (no inventory side effects can land from a `pending` webhook by definition) but worth closing to keep the status distribution clean."

- slug: phase4-trigger-enqueue-saturation
  title: "Phase 4 X-1.b — Trigger.dev enqueue ceiling (DEFERRED — production has 0% operational impact)"
  due_date: 2026-07-24
  severity: low
  context: "RESOLVED-AS-DEFERRED 2026-04-24. Original concern: Sub-pass A.1 baseline (50 concurrent × 60s sustained against Northern Spy prod) showed 77% enqueue_failed 503s. X-1.b probe (scripts/_phase4-x1b-trigger-rate-limit-probe.ts) characterized the ceiling as a hard cliff between concurrency 10-15 with 27.5 sustainable rps, AND penalty-box behavior at concurrency ≥20 (locks out legitimate webhooks for ≥minutes). HOWEVER, follow-up operational verification (scripts/_phase4-x1b-status-verification.ts + _phase4-x1b-historical-burst-audit.ts) confirms: in 30 days of production traffic (66,415 events) ZERO enqueue_failed rows ever occurred. Single-second peak was 30 rps (one event, 2026-04-20T15:37) but worst sustained 60s rate was only 13.1 rps and worst 5-min rate was 10.3 rps — both well below the 27.5 ceiling. Production bursts are too short to consume the rate-limit bucket. DECISION (X-1-decision-DRAFT.md, full reasoning): defer Phase 4 §9.5 build (Edge migration + waitUntil + batchTrigger) until ANY of these triggers fires: (1) enqueue_failed > 0 for 3+ consecutive days; (2) single-second peaks ≥30 rps in 5+ separate hours within a week; (3) sustained 60s rate ≥20 rps; (4) Vercel cold-start p95 degrades to >2,500 ms; (5) Shopify deactivates a webhook subscription; (6) new platform integration adds 3-5× current volume. RECOMMENDATION: weekly automated re-run of _phase4-x1b-status-verification.ts as a defensive monitor; quarterly re-run of _phase4-burst-test.ts --scale=full to re-validate the empirical envelope. ACTION at T+90d (2026-07-24): re-run status verification + historical audit, decide whether triggers have fired or whether to extend the deferral."
- slug: sku-coverage-followups-2026-04-18
  title: "SKU coverage audit follow-ups (2026-04-18, post-structural-seed)"
  due_date: 2026-04-25
  severity: medium
  context: "After scripts/audit-sku-coverage.ts + scripts/seed-missing-inventory-levels.ts (840 safe-zero) + scripts/reconcile-missing-inventory-levels.ts (752 reconciled from SS/BC truth) closed the 1,592-variant NULL-level gap on 2026-04-18, four residual issues remain that cannot be auto-fixed: (1) 1 variant has NULL/empty SKU and was skipped — needs operator triage to decide rename or delete. (2) 73 SS-only SKUs with -CLEAR/-COLOR suffixes (e.g. LP-DR-046-CLEAR, LP-NS-133-REDPINK) are SS records left over from before CLAUDE.md Rule 8 (one product per SKU for music formats) was adopted; SS still tracks color variants we collapsed. Decision needed: re-split DB records or backfill SS to merge color variants into the parent SKU. (3) 609 BC-live SKUs (mostly LR-MBOT-S-1, LR-MBOT-S-2 size-option pattern) are not in our DB — bandcamp-sync currently imports the package SKU but skips per-option size SKUs. Add per-option SKU import to src/trigger/tasks/bandcamp-sync.ts. (4) 82 DB BC-mapped SKUs with slug-hash names (CD-THEMASQU-9Q3Q etc.) that BC live no longer returns — likely deleted/private bandcamp items; needs a cleanup pass to either re-link or mark mappings inactive. (5) 1 case mismatch LP-DR-046-Clear in DB vs LP-DR-046-CLEAR in SS — one-row UPDATE. Full evidence: reports/finish-line/sku-coverage-2026-04-18T20-31-07-642Z.json, reports/finish-line/seed-missing-levels-2026-04-18T20-26-53-784Z.json, reports/finish-line/reconcile-missing-levels-2026-04-18T20-30-47-738Z.json. None of these block resume of inventory_sync_paused; they are catalog-quality items."
- slug: bandcamp-orphan-cleanup-verification
  title: "Bandcamp orphan cleanup verification (no orphan re-growth)"
  due_date: 2026-04-26
  severity: medium
  context: "After 2026-04-19 dupe hardening (DB-first unmatched path in bandcamp-sync + package-level dedup backstop index) and orphan cleanup script rollout, verify that no new orphan draft products are being created. Checks: (1) rerun scripts/cleanup-bandcamp-orphan-shopify.ts in dry-run mode — should report 0 would_archive rows for the recent window, (2) query warehouse_review_queue for category='bandcamp_sync_variant_create_failed' in the last 7 days — expected 0 after hot period, (3) sample 10 recent bandcamp-sync runs in channel_sync_log for unexpected spikes in items_failed tied to variant insert collisions."
- slug: ws3-3g-locations-admin-page
  title: "WS3 §3g — Standalone /admin/inventory/locations admin page (DONE 2026-04-18)"
  due_date: 2026-04-19
  severity: medium
  status: done
  done_at: 2026-04-18
  context: "Saturday Workstream 3 closeout (2026-04-18) deferred this to Sunday UX polish. CLOSED 2026-04-18 (1hr sprint #2 after WS3 closeout). Shipped src/app/admin/inventory/locations/page.tsx — a full operator surface for warehouse_locations: search by name, filter by location_type, filter active-only vs all, ShipStation v2 sync state per row (Synced / Local only / Mirror failed) with hover-tooltip on the error message, Last-synced relative time, one-click Retry button on rows with shipstation_sync_error (calls retryShipstationLocationSync), Deactivate button (Server Action blocks if any warehouse_variant_locations row has positive quantity), New-location dialog (calls createLocation, surfaces all four CreateLocationWarning variants as toasts), New-range dialog (calls createLocationRange, shows inline-vs-Trigger badge live based on size, surfaces created/exists/error counts on completion). Inline rename intentionally deferred — Server Action calls ShipStation FIRST on rename per v4 hardening §17.1.b and the failure UX needs more than a 1hr sprint buys. Sidebar gained 'Locations' nav entry under Inventory (Warehouse icon, reused). Quality gates: typecheck + biome + 112 vitest files / 1084 tests all green. No new tests added — page is pure UI plumbing over already-tested Server Actions in src/actions/locations.ts (those tests cover all the warning paths the dialogs surface)."
- slug: ws3-ux-polish-sunday
  title: "WS3 Sunday UX polish — bulk Avail edit only (per-row count indicators + locations admin page DONE)"
  due_date: 2026-04-19
  severity: medium
  context: "Bundled Sunday UX polish from §28 of docs/plans/shipstation-source-of-truth-plan.md. PROGRESS 2026-04-18 (two 1hr sprints after WS3 closeout): item (1) per-row count-status indicators on the inventory list — DONE. Item (3) standalone /admin/inventory/locations admin page — DONE (see ws3-3g-locations-admin-page slug above for detail). REMAINING: only item (2) bulk Avail edit shortcut on the inventory list. /admin/inventory now shows a 'Counting…' amber badge with 'Xm ago by NAME' subline on every row whose warehouse_inventory_levels.count_status='count_in_progress'. Display-only, no new write paths. getInventoryLevels extended (count_status, count_started_at, embedded users:count_started_by(id,name) join — FK from migration 20260418000001). InventoryRow gained countStatus/countStartedAt/countStartedByName; client-side getClientInventoryLevels hard-nulls them so staff workflow state never leaks to clients. Companion test in tests/unit/actions/inventory.test.ts updated. Quality gates: typecheck + biome + 112 vitest files / 1084 tests all green. REMAINING items for Sunday: (2) bulk Avail edit shortcut on the inventory list, (3) standalone /admin/inventory/locations page (separate slug ws3-3g-locations-admin-page)."
- slug: ws3-ux-dry-run-1
  title: "WS3 UX dry-run #1 (Sunday ~10:00) — Avail latency + count-session fanout suppression"
  due_date: 2026-04-19
  severity: high
  context: "Per §31 halt-criteria of docs/plans/shipstation-source-of-truth-plan.md. Part A: edit an Avail cell, observe Bandcamp + ShipStation update within 60s. Part B: start a count session, edit per-location quantities, observe NEITHER Bandcamp NOR ShipStation update during the in-progress phase (fanout suppression invariant). Both parts MUST pass before ramping fanout to 10%."
- slug: ws3-3f-per-location-rewrite
  title: "WS3 §3f — Per-location rewrite of shipstation-v2-adjust-on-sku (CLOSED WONTFIX 2026-04-18)"
  due_date: 2026-04-19
  severity: low
  status: done
  done_at: 2026-04-18
  context: "CLOSED WONTFIX 2026-04-18 by Phase 1 §15.3 probe (reports/probes/ss-v2-per-location-2026-04-18T18-41-42-592Z.json, scripts/probe-ss-v2-per-location.ts). Empirical finding: ShipStation v2 collapses per-(warehouse, sku) writes into a SINGLE SKU-total row. Case 1 seeded Loc-A=10/Loc-B=20/Loc-C=30 against TEST-PROBE SKU; listInventory returned 1 row with available=60 and inventory_location_id=null. Case 2 decremented Loc-A by 5 → single row dropped to 55 (independent of which location was passed). Case 3 modify new_available=15 returned 400 (asymmetric per Patch D2). The per-location rewrite is therefore moot — v2 doesn't track per-location for SKUs within a warehouse. SKU-total path that shipped via fanout (audit fix F1) is canonical. has_per_location_data column stays as a flag for the warehouse_variant_locations join shape but no longer pivots fanout behavior."
- slug: v2-fetch-empty-body-rollout
  title: "v2Fetch empty-body fix rollout — verify v2 ledger error rate drops"
  due_date: 2026-04-25
  severity: medium
  context: "Phase 2B fix (2026-04-18) — Phase 1 §15.3 probe surfaced that v2 inventory POST returns 200/empty-body on success, but the v2Fetch wrapper called response.json() unconditionally, throwing 'Unexpected end of JSON input'. Caller marked external_sync_events row 'error' even though the write succeeded server-side. Fixed in src/lib/clients/shipstation-inventory-v2.ts (treats 204 + 200/empty + 200/whitespace as success, throws descriptive error on malformed JSON). Tests added in tests/unit/lib/clients/shipstation-inventory-v2.test.ts. Follow-up: 7 days post-deploy, verify external_sync_events.status='error' rate for system='shipstation_v2' has dropped meaningfully (was likely the dominant error class). If still elevated, check v2 5xx rates and headers."
- slug: v2-stale-test-locations
  title: "Untrappable orphan TEST-PROBE locations in ShipStation v2"
  due_date: 2026-04-25
  severity: low
  context: "Phase 1 §15.3 probe (2026-04-18) created 3 TEST-PROBE locations (se-4106160, se-4106161, se-4106162) under warehouse se-214575. Probe Case 4 confirmed Reviewer A's hypothesis: v2 rejects DELETE on inventory_locations that have ever held inventory (HTTP 400, 3-retry exp backoff also failed). The 3 locations are now stuck in v2 forever. Phase 8b cleanup script must rebrand from 'delete stale TEST locations' to 'list + UI-filter stale TEST locations + open low-severity review row'. Action for operator: filter TEST-PROBE-* names out of warehouse picker UI; treat as permanent infrastructure. Forensic IDs in reports/probes/ss-v2-per-location-2026-04-18T18-41-42-592Z.json."
- slug: v2-modify-quantity-error-message
  title: "Investigate v2 modify validator returning 'quantity' error for missing new_available"
  due_date: 2026-05-15
  severity: low
  context: "Phase 1 §15.3 probe Case 3 (2026-04-18) attempted modify new_available=15 (which our client validates client-side as >= 1, then sends only new_available — NOT quantity). v2 returned 400 with errors[0].message containing {\"errors\": {\"quantity\": [\"Must be greater than or equal to 1.\"]}}. Either v2's validator misreports the field name or our client request shape is being misinterpreted. Currently a non-issue because we have rule §7.1.6 (no modify with new_available=0) and the probe finding (sku_total semantics) means the 1:N modify call would have been pointless anyway. But the error message would be confusing to a future caller who tries to use modify legitimately."
- slug: phase-7-dormant-cleanup
  title: "Phase 7: dormant client-store code cleanup"
  due_date: 2026-07-13
  severity: medium
  context: "90-day dormancy review of client-store webhook + multi-store push code paths. Decide whether to delete or revive based on adoption telemetry."
- slug: tier1-9-better-stack
  title: "Tier 1 #9: Better Stack synthetic monitoring"
  due_date: 2026-05-13
  severity: high
  context: "30-day waiver expiration. Required before sustained 100% rollout. Operator: provision Better Stack account, register staff portal heartbeat, document in TRUTH_LAYER.md."
- slug: tier1-10-statuspage
  title: "Tier 1 #10: statuspage.io public status page"
  due_date: 2026-05-13
  severity: high
  context: "30-day waiver expiration. Required for client-facing incident comms. Operator: provision statuspage.io account, link from portal footer, wire incident webhook to Trigger task."
- slug: external-sync-events-retention
  title: "external_sync_events retention cron verification"
  due_date: 2026-04-25
  severity: low
  context: "Confirm 7-day retention is firing weekly via Trigger.dev dashboard. Cron task: external-sync-events-retention. Pre-existing per Patch D3."
- slug: megaplan-ramp-admin-page
  title: "/admin/settings/megaplan-ramp UI surface for ramp percent + audit trail"
  due_date: 2026-04-19
  severity: medium
  context: "Phase 6 (finish-line plan v4) shipped the rollout infrastructure (setFanoutRolloutPercentInternal helper, setFanoutRolloutPercent staff Server Action, getFanoutRolloutAudit reader, ramp-halt-criteria-sensor cron, both Phase 6 migrations applied to remote, 22 unit tests green). The admin UI page /admin/settings/megaplan-ramp was DEFERRED because Phase 7 ramp itself was deferred (workspace lacks shipstation_v2_inventory_warehouse_id and _location_id; inventory_sync_paused is currently true). Page should: show current fanout_rollout_percent prominently, render fanout_rollout_audit trail (ts/percent_before/percent_after/reason/actor) reverse-chronological, expose ramp buttons (0/10/50/100) wired to setFanoutRolloutPercent with required reason field, and show last 5 ramp_halt_evaluator sensor_readings rows as an embedded health panel. Build after workspace v2 IDs are populated and inventory_sync_paused goes false."
- slug: phase-6-shipstation-v2-5xx-rate-sensor
  title: "Wire shipstation_v2_5xx_rate sensor reading"
  due_date: 2026-04-25
  severity: medium
  context: "ramp-halt-criteria-sensor H-4 reads sensor_name='shipstation_v2_5xx_rate' value.rate from sensor_readings. The sensor task is in place but no producer writes that row yet. Either: (a) extend sensor-check to compute v2 5xx rate from external_sync_events.status='error' filtered to system='shipstation_v2' over 30 minutes, OR (b) add a v2-client-side telemetry hook that increments a counter and a flush cron writes the rolling rate. Until either lands, H-4 is structurally inactive (returns 'no v2 traffic in window' as detail). Not a blocker for first ramp window but should land before sustained 100%."
- slug: migration-ordering-from-scratch
  title: "external_sync_events migration ordering bug (from-scratch deploys)"
  due_date: 2026-05-31
  severity: medium
  context: "v6 finding — external_sync_events table is referenced by indexes/views before its CREATE TABLE in the migration sequence. Fine for incrementally-migrated databases but breaks `supabase db reset`. Move CREATE TABLE earlier or split into a leading migration. Phase 4a (finish-line plan v4, 2026-04-13) explicitly de-scoped this from the one-day closeout per the operational guardrails de-scope ladder — triple-verification migration work (db reset + db diff --linked + db push --dry-run) needs a dedicated session, not a slot in a multi-phase day. Carry into a future migration-only window."
- slug: evaluate-sku-deterministic-bucketing
  title: "Evaluate SKU-deterministic bucketing for fanout-guard (R-24 follow-up)"
  due_date: 2026-07-13
  severity: low
  context: "Phase 8a (finish-line plan v4, 2026-04-13) is set to land an optional `bucketingKey: 'correlation_id' | 'sku'` mode in `loadFanoutGuard`. At 100% rollout the choice is a no-op so it ships safely, but the alternate `'sku'` mode then sits as undocumented dead code unless we force a future decision. Trade-off: per-SKU consistency (every event for a given SKU is in or out of the bucket) vs per-event independence (each event hashes independently, smoothing distribution at intermediate percentages). Decide before next ramp-from-0 scenario whether to flip the default or delete the option."
- slug: bulk-batch-correlation-grouping
  title: "Refactor bulk-update-available + submitManualInventoryCounts to share a per-row engine"
  due_date: 2026-07-13
  severity: low
  context: "Phase 3 (finish-line plan v4, 2026-04-13) shipped `src/trigger/tasks/bulk-update-available.ts` as a Trigger-task variant of `submitManualInventoryCounts` for very large batches (Rule #41 hardening). The Trigger task currently re-implements the per-row contract (pre-fetch, validate, recordInventoryChange) rather than sharing a helper because the Server Action already had its own well-tested path and we did not want the refactor risk in a one-day closeout. Future work: factor the per-row write loop into `src/lib/server/bulk-inventory-engine.ts`, have both callers delegate, and add a contract test that asserts both paths produce identical correlation_ids and ledger rows for the same payload. Keeps the Trigger split safe while collapsing duplicate logic."
- slug: hrd-23-runtime-guard
  title: "HRD-23 — promote scripts/check-webhook-runtime.sh to a hard CI gate"
  due_date: 2026-05-15
  severity: high
  context: "Direct-Shopify cutover finish-line F-2 shipped `export const runtime = 'nodejs'` + `export const dynamic = 'force-dynamic'` on every webhook Route Handler, plus `scripts/check-webhook-runtime.sh` to enforce the invariant going forward. The script is wired into `scripts/cloud-agent-verify.sh` (run by `pnpm verify:cloud`) but is NOT yet a required GitHub Actions check on `.github/workflows/ci.yml`. Action: add a dedicated CI step that runs ONLY this script and fails the PR if any new webhook route lands without the two exports. Belt-and-suspenders to prevent a future Vercel build from accidentally inlining `req.text()` into a static cache or moving a webhook to the Edge runtime (HMAC verification depends on Node crypto)."
- slug: hrd-32-auto-delete-notification
  title: "HRD-32 — auto-delete notification when registerWebhookSubscriptions stops returning a topic"
  due_date: 2026-06-01
  severity: medium
  context: "When a Shopify webhook subscription is auto-deleted by Shopify (5+ consecutive 5xx responses, per Shopify docs), our re-register diff (B-3 / `diffWebhookSubscriptions`) will surface it as `toCreate`, but only when an operator opens the Channels page. Action: extend the deferred `shopify-webhook-health-check` Trigger task (placeholder mentioned in `client_store_connections.webhook_subscriptions_audit_at` comment) to compare current Shopify state against the `webhook_topic_health` snapshot and create a high-severity `warehouse_review_queue` row for any topic that disappeared. Prevents a silent webhook-loss outage during weekends/holidays."
- slug: hrd-09-health-check-task
  title: "HRD-09 — implement the shopify-webhook-health-check Trigger task"
  due_date: 2026-06-01
  severity: medium
  context: "The finish-line plan added the `webhook_subscriptions_audit_at` + `webhook_topic_health` columns and the manual `Re-register webhooks` button on Channels (B-3), but the recurring health-check task itself is deferred. Action: scaffold `src/trigger/tasks/shopify-webhook-health-check.ts` as a `schedules.task` (cron `0 */4 * * *`, pinned to a new `shopify-health` queue with `concurrencyLimit: 1`) that iterates all active Shopify `client_store_connections`, calls `listWebhookSubscriptions`, runs `diffWebhookSubscriptions`, persists the snapshot via the same code path as B-3, and stamps `webhook_subscriptions_audit_at`. Surface diff drift on the Channels page health card (new `audit_age` field). Pair with hrd-32-auto-delete-notification — both share infrastructure."
- slug: hrd-10-verify-rollout
  title: "HRD-10 — verify normalize+verifyShopDomain remains the only credential-write path post-cutover"
  due_date: 2026-05-15
  severity: high
  context: "F-5 (HRD-10) added Shopify `myshopifyDomain` verification in `/api/oauth/shopify/route.ts` and persists `client_store_connections.shopify_verified_domain` on every successful install. Action 7 days post-cutover: (1) query `select count(*) from client_store_connections where platform='shopify' and shopify_verified_domain is null and created_at > '<cutover-date>'` — must be 0; any row indicates a credential-write path that bypassed the OAuth callback. (2) Confirm no new file other than `src/app/api/oauth/shopify/route.ts` writes the `api_key` column. Add a CI grep-guard if drift detected. (3) Spot-check 3 `warehouse_review_queue` rows with `category='security' and group_key like 'shop_token_mismatch:%'` — verify zero rows means a calm install rollout, not silent guard failure."
- slug: hrd-28-followup-smoke
  title: "HRD-28 — fulfillmentCreate GraphQL migration follow-up smoke test"
  due_date: 2026-05-22
  severity: high
  context: "B-2 migrated `markShopifyFulfilled` from REST to the GraphQL `fulfillmentCreate` mutation (commit `61f4eea`). The new path covers (a) `OPEN` + `IN_PROGRESS` fulfillment-order selection, (b) SKU-coverage-driven tie-breaking with `oldest GID` fallback, and (c) raw `errors[]` + `userErrors[]` capture into `warehouse_review_queue.metadata`. Action 14 days post-cutover: query `select count(*), category from warehouse_review_queue where category in ('shopify_fulfillment_userErrors', 'shopify_fulfillment_no_actionable_fo') and created_at > '<cutover-date>' group by category` — investigate any unexpected `no_actionable_fo` clusters (likely indicates a Shopify FO state we don't handle, e.g. `CANCELLED` or `ON_HOLD`). Cross-reference against the `sensor_readings` row count for `mark-platform-fulfilled.ambiguous_fulfillment_order` to gauge tie-breaker noise. If tie-breaker fires >5% of fulfillments, add deterministic ordering by `lineItems[].sku` set hash."
- slug: credentials-encryption
  title: "Audit credential-encryption posture across client_store_connections + shopify_app_*_encrypted columns"
  due_date: 2026-05-30
  severity: high
  context: "Open question Q3 from the finish-line plan: the `shopify_app_client_secret_encrypted` (and adjacent `*_encrypted`) columns on `client_store_connections` carry the `_encrypted` suffix but it is NOT verified that pgsodium / pgcrypto round-trips are actually wired up in this repo. Action: (1) probe a row in staging with `select length(shopify_app_client_secret_encrypted) from client_store_connections where shopify_app_client_secret_encrypted is not null limit 5` — pgsodium-encrypted bytea will be larger than the plaintext secret length; if values look like 32-char hex they're plaintext-disguised-as-encrypted. (2) Document findings in TRUTH_LAYER.md `Security Posture` section (create if missing). (3) If plaintext: design a real encryption migration (pgsodium aead_encrypt with a per-column nonce + key rotation plan) — NOT a one-time rewrite without a key-management story. (4) Until fixed, gate the `shopify_app_client_secret_encrypted` write path behind a `STAFF_CREDS_PLAINTEXT_ACK` env flag that staff must explicitly set to acknowledge the posture."
- slug: biome-warning-sweep
  title: "Sweep the 49 biome warnings + 7 infos that have accumulated in the repo"
  due_date: 2026-05-30
  severity: low
  context: "F-12 (finish-line audit). `pnpm check` on a clean tree currently reports 49 warnings + 7 infos (all pre-existing — no errors). Most are `lint/style/noNonNullAssertion` in test fixtures and a small cluster of `lint/correctness/noUnusedVariables`. Do NOT reopen HRD-33 (formatter rules). Action: (1) `pnpm check --max-diagnostics=200` to see the full set, (2) categorize: test-only (apply with `--unsafe` carefully) vs production code (manual review), (3) ship one PR per category to keep the diff reviewable, (4) once warnings are <10, gate `pnpm check` to fail on new warnings via `--error-on-warnings` in CI."
- slug: northern-spy-scratch-removal
  title: "Permanently remove scripts/audit/2026-04-22/_*northern-spy*.ts scratch helpers"
  due_date: 2026-05-15
  severity: low
  context: "F-8 (finish-line audit). The `northern-spy` scratch scripts were one-off helpers used during the 2026-04-22 expanded audit pass. They have been moved out of `scripts/` into `scripts/audit/2026-04-22/` so they no longer pollute the top-level scripts folder; they remain under git for forensic value. Action: by `due_date`, either (a) delete the directory if no operator has needed to re-run them, or (b) refactor any script that has proven repeatedly useful into a properly-tested helper under `scripts/` with documentation. Default action: delete."
- slug: bandcamp-rate-limit-instrumentation
  title: "Instrument Bandcamp API client to capture rate-limit + Retry-After headers"
  due_date: 2026-06-01
  severity: medium
  context: "Q4 (finish-line plan). The B-1 cron at `*/15` × N workspaces × ~120 req/run × the implicit `bandcampQueue` (concurrencyLimit:1) currently has NO observability into how close we are to Bandcamp's soft limit (~20 req/min per token family). `src/lib/clients/bandcamp.ts` does NOT inspect response headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`) on any of `getOrders` / `getMerchDetails` / `update_shipped` / `update_quantities` / `sales_report` calls. `src/trigger/tasks/bandcamp-order-sync.ts` documents the cadence budget in code comments (lines 328-332) but the threshold (`N≥10 active bands → revisit cadence`) is operator-judgment, not sensor-driven. Action: (1) wrap every Bandcamp `fetch()` call in a single `bandcampApiCall(method, url, body, accessToken)` helper that captures response headers + body together; (2) on every call emit a `sensor_readings` row with `metric='bandcamp.rate_limit_remaining'` / `metric='bandcamp.retry_after_ms'` per workspace; (3) on HTTP 429, throw a typed `BandcampRateLimitError` carrying the `Retry-After` value so callers (especially the `bandcampQueue`-pinned tasks) can respect it; (4) wire a halt-criterion into `ramp-halt-criteria-sensor.ts` that auto-pauses the `*/15` cron via `workspaces.bandcamp_sync_paused=true` if rate_limit_remaining <5 in any workspace for 2 consecutive ticks; (5) document the new sensors + halt criterion in TRUTH_LAYER. This is the prerequisite for safely scaling beyond N=10 workspaces — the docs say `revisit cadence` but without the headers we have no signal to act on. Falling back to `*/30` is a reactive workaround; this slug is the proactive fix."
- slug: sku-autonomous-phase1-apply-outcome-transition-rpc
  title: "CLOSED 2026-04-26 — Phase 1 residual: apply_sku_outcome_transition RPC wrapper + concurrency test (SKU-AUTO-14 + SKU-AUTO-22 flipped to Active)"
  due_date: 2099-01-01
  severity: low
  context: "CLOSED 2026-04-26. Landed: migration `supabase/migrations/20260428000002_sku_autonomous_matching_phase1_rpc.sql` (applied to remote) — RPC `apply_sku_outcome_transition(p_identity_match_id, p_expected_state_version, p_expected_from_state, p_to_state, p_trigger, p_reason_code, p_evidence_snapshot, p_triggered_by)` returning `(new_state_version, transition_id)`. Takes `pg_advisory_xact_lock` FIRST, then OCC + from_state drift + terminal-state egress + alias-state rejection + UPDATE + INSERT `sku_outcome_transitions` in one transaction. TS wrapper `applyOutcomeTransition()` in `src/lib/server/sku-outcome-transitions.ts` runs `validateOutcomeTransition()` client-side first, maps typed errors (`stale_state_version`, `from_state_drift`, `identity_match_not_found`, `identity_match_inactive`, `terminal_state_non_human_egress`, `to_state_forbidden_on_identity_row`, `rpc_error`, `unexpected_response_shape`). Tests: 15 wrapper cases + migration-shape drift guard in `tests/unit/lib/server/sku-outcome-transitions.test.ts`; live-DB concurrency evidence (N=8 parallel callers, exactly one wins, state_version bumped once, one audit row) in `tests/integration/sku-outcome-transition-concurrency.test.ts` (`pnpm test:integration`). Release gates SKU-AUTO-14 + SKU-AUTO-22 flipped Pending-Phase-2 → Active. `due_date=2099-01-01` + `severity=low` keep the Rule #74 deferred-followups-reminder idempotent `group_key='deferred-followup-{slug}'` from re-queueing (the reminder task only surfaces entries whose `due_date <= today`). Original hand-off context is preserved in git history on commit that added this slug, and in the 2026-04-26 `engineering_map.yaml` `updated_at` entry."
- slug: sku-autonomous-phase2-normalized-order-adapter
  title: "CLOSED 2026-04-26 — Phase 2 substrate: normalized-order adapter + order-hold policy/evaluator + CandidateEvidence/gate classifier"
  due_date: 2099-01-01
  severity: low
  context: "CLOSED 2026-04-26. Landed across three atomic slices: (2.A) `src/lib/server/normalized-order.ts` + `src/lib/server/normalized-order-loader.ts` — pure adapter + DB-backed loader producing `NormalizedClientStoreOrder` from webhook payloads AND `warehouse_orders`/`warehouse_order_items` rows. Both paths now lower to the same shape before entering hold evaluation (SKU-AUTO-3). Fail-open reasons via `NormalizeOrderFailureReason` discriminated union. (2.B) `src/lib/server/order-hold-policy.ts` + `src/lib/server/order-hold-evaluator.ts` — split into pure policy (`classifyOrderLine` / `decideOrderHold` / `buildHoldDecision`) + async orchestrator (`evaluateOrderForHold` batch-fetches alias/identity/inventory/fetch-status in ONE query per table, not N-per-line). `HoldReason` enum: `unknown_remote_sku`, `placeholder_remote_sku` (via `isPlaceholderSku`), `non_warehouse_match`, `fetch_incomplete_at_match`, `all_lines_warehouse_ready`. `HoldAudience` splits notifications into `clientAlert` vs `staffReview`. Deterministic `holdReason` selection by `HOLD_REASON_PRIORITY` ensures webhook-path and poll-path evaluations are byte-identical for identical DB state. (2.C) `src/lib/server/sku-candidate-evidence.ts` — `DisqualifierCode` enum (17 codes: identity/variant/operational/negative), `CandidateEvidence` struct with tri-state `boolean | \"unknown\"` on variant slots, `buildCandidateEvidence()` + `buildCandidateEvidenceFromTitles()`, `classifyEvidenceGates()` (identity → variant → operational gate sequence with hard-negative short-circuit, plan §1691–1740), `EvidenceOverall` union `{pass, identity_only, stock_exception, shadow_identity, holdout, reject}`, `IdentityOutcomeState` matching the DB CHECK, `selectOutcomeFromGates()`. `src/lib/server/sku-matching.ts::rankSkuCandidates()` extended ADDITIVELY with optional `evidenceContext` parameter — existing callers unchanged; new callers receive `evidence` + `evidenceGates` + `disqualifierCodes` on every `RankedSkuCandidate`. Tests: `normalized-order.test.ts`, `normalized-order-loader.test.ts`, `order-hold-policy.test.ts` (every HoldReason branch + priority + audience), `order-hold-evaluator.test.ts` (DB query patterns + batching), `sku-candidate-evidence.test.ts` (50 cases covering buildCandidateEvidence / classifyEvidenceGates all branches / hard negatives / platform-specific logic / selectOutcomeFromGates / title-parsing integration), `sku-matching.test.ts` (5 additive cases proving zero-break for omitted context + evidence attachment + hard-negative reject + identity-only operational fail + Woo platform gating). `TRUTH_LAYER.md` autonomous-matching section gains 'Normalized order adapter + hold substrate' and 'Structured candidate evidence + gate sequence' invariants. `due_date=2099-01-01` + `severity=low` keep the Rule #74 deferred-followups-reminder idempotent `group_key='deferred-followup-{slug}'` from re-queueing."
- slug: sku-autonomous-phase3-alias-promotion-and-hold-rpcs
  title: "Phase 3 — alias-promotion wrapper + order-hold RPC pair + client alert task"
  due_date: 2026-06-10
  severity: high
  context: "Phase 3 promotes the Phase 2 evaluator into mutations. Four surfaces: (1) src/lib/server/sku-alias-promotion.ts wrapping promote_identity_match_to_alias (already shipped in 20260428000001_sku_autonomous_matching_phase0.sql) with the promotion-path policy (paths A/B/C) and the stock-stability precondition `isStockStableFor('promotion', ...)` (SKU-AUTO-8). Writes BOTH the sku_outcome_transitions row AND the sku_autonomous_decisions row. (2) `apply_order_fulfillment_hold(p_order_id, p_reason, p_cycle_id, p_held_lines jsonb, p_actor_kind, p_actor_id)` PL/pgSQL RPC — updates warehouse_orders.fulfillment_hold='on_hold' + fulfillment_hold_started_at + fulfillment_hold_cycle_id AND inserts the `hold_applied` row into order_fulfillment_hold_events in the same transaction (SKU-AUTO-15). The companion `release_order_fulfillment_hold(p_order_id, p_resolution_code, p_note?)` RPC moves state to 'released', inserts `hold_released`, and rejects any resolution_code outside {staff_override, fetch_recovered_evaluator_passed, alias_learned, manual_sku_fix, order_cancelled} (SKU-AUTO-17 + SKU-AUTO-32). `staff_override` without a note is rejected at the RPC level. Committable-warehouse lines on a partial-hold order MUST be committed via commitOrderItems() in the same transaction as the hold write (SKU-AUTO-21). (3) `send-non-warehouse-order-hold-alert` Trigger task — idempotent on (workspace_id, order_id, hold_cycle_id) via UNIQUE on order_fulfillment_hold_events (order_id, hold_cycle_id, event_kind='hold_alert_sent') (SKU-AUTO-16). (4) Bulk-hold suppression: when ≥10 `fetch_incomplete_at_match` holds hit the same (workspace_id, connection_id) in a rolling 15-minute window, emit ONE ops alert and zero client emails for the suppressed window (SKU-AUTO-31). Integration tests cover: mixed order partial-hold commits correctly, concurrent hold+release on the same order serialize via the advisory lock, staff_override rejection without note, fetch_recovered_evaluator_passed accepted only from the recovery task (not from staff)."
- slug: sku-autonomous-phase4-webhook-ingress-rehydrate
  title: "Phase 4 — webhook ingress demotion-rehydrate path"
  due_date: 2026-06-25
  severity: medium
  context: "When an identity row sits in outcome_state='client_stock_exception' and a subsequent client-store webhook reports positive remote stock, webhook ingress must re-promote — NOT fire unknown-SKU discovery (SKU-AUTO-24). Action: in src/trigger/tasks/process-client-store-webhook.ts, before the existing 'unknown SKU?' branch, query client_store_product_identity_matches for a live row keyed by (connection_id, remote_fingerprint) OR (connection_id, remote_product_id, remote_variant_id) OR (connection_id, remote_inventory_item_id) — three partial unique indexes exist for this exact lookup (SKU-AUTO-13). If found AND outcome_state='client_stock_exception' AND the inbound webhook carries positive remote stock: call `promote_identity_match_to_alias(identity_match_id, expected_state_version, reason_code:='stock_positive_promotion', triggered_by:='webhook_rehydrate')` (the RPC already exists). Write a sku_autonomous_decisions row in the same transaction documenting the webhook's `available` value + `observed_at`. If `classifyStockTier()` returns 'cached_only' or 'unknown' for the inbound signal, DO NOT promote — keep the row demoted and log the re-evaluation attempt. The normalized-order adapter from the Phase 2 follow-up is a prerequisite. Integration test fires two webhooks on the same identity: first zero stock → demotion; second positive stock → re-promotion with matching reason_code."
- slug: sku-autonomous-phase5-background-tasks
  title: "Phase 5 — Trigger tasks: shadow promotion, stock sampler, hold recovery, holdout sweep"
  due_date: 2026-07-15
  severity: medium
  context: "Four new Trigger tasks, each read-mostly with bounded mutation surfaces. (1) `sku-shadow-promotion` — nightly; samples 'auto_shadow_identity_match' rows where `state_version` has been stable for ≥7 days AND passes the full promotion-path A/B/C policy; promotes to 'auto_database_identity_match' via applyOutcomeTransition (NOT to auto_live_inventory_alias — that requires the live-alias flag + admin sign-off per SKU-AUTO-19). (2) `stock-stability-sampler` — */15 cron; samples connection_id/remote_inventory_item_id/variant_id tuples into stock_stability_readings so `isStockStableFor()` has real history to read. Respects workspaces.sku_autonomous_emergency_paused=true. Stock-sampler rate budget is separate from the bandcamp-api OAuth queue. (3) `sku-hold-recovery-recheck` — */10 cron; for every warehouse_orders row with fulfillment_hold='on_hold' AND `hold_reason IN ('fetch_incomplete_at_match', 'unknown_remote_sku', 'placeholder_remote_sku')`, re-run evaluateOrderForHold() against current inventory; if it now returns 'pass' OR evaluates as fully-committable, call release_order_fulfillment_hold with resolution_code='fetch_recovered_evaluator_passed' (SKU-AUTO-32 — this resolution_code is reserved for this task; the RPC rejects it from any other caller). (4) `sku-holdout-stop-condition-sweep` — daily; for every identity row in outcome_state='auto_holdout_for_evidence', count evaluations (via sku_outcome_transitions WHERE to_state='auto_holdout_for_evidence' AND identity_match_id=id) AND days since created_at; if evaluations ≥10 OR days ≥90, transition to 'auto_reject_non_match' with reason_code='holdout_stop_condition_exhausted' (SKU-AUTO-9). Each task needs a dedicated queue with concurrencyLimit:1 (except the stock sampler which can run concurrencyLimit:3 against the scrape-style budget). Tests land in tests/unit/trigger/tasks/{sku-shadow-promotion,stock-stability-sampler,sku-hold-recovery-recheck,sku-holdout-stop-condition-sweep}.test.ts."
- slug: sku-autonomous-phase6-admin-ui-surfaces
  title: "Phase 6 — admin views for autonomous runs, decisions, hold queue, identity rows"
  due_date: 2026-07-25
  severity: medium
  context: "Staff read-surface for the autonomous rollout — feature-flagged behind sku_autonomous_ui_enabled until Phase 7 GA. Three admin pages, one client-portal page: (1) /admin/settings/sku-matching/autonomous-runs — lists sku_autonomous_runs with filters (workspace, connection, status, dry_run true/false, started_at range); detail drawer renders sku_autonomous_decisions rows as a two-column diff (remote listing ↔ warehouse candidate) with evidence_json expanded per CandidateEvidence. (2) /admin/orders/holds — lists warehouse_orders with fulfillment_hold='on_hold' grouped by hold_reason; per-row actions: resolve via release_order_fulfillment_hold (resolution_code picker — staff_override requires note; manual_sku_fix opens the SKU matching drawer), bulk-select multiple orders for batch release with one shared resolution_code + note. (3) /admin/settings/sku-matching/identity-matches — lists client_store_product_identity_matches with outcome_state filter; detail drawer exposes state_version, promoted_alias_id link, full transition history from sku_outcome_transitions. (4) /portal/stock-exceptions — client-facing view of outcome_state='client_stock_exception' rows for the client's own connections only (RLS via get_user_org_id()); shows 'we never saw positive stock on your store for this listing — either add stock or unmap the listing' guidance. All four pages emit query-key tests (SKU-AUTO-5). Phase 6 is where the admin sign-off workflow gets wired: before any connection gets `sku_identity_autonomy_enabled=true` or `sku_live_alias_autonomy_enabled=true`, a `warehouse_review_queue` row of category='sku_autonomous_canary_review' (severity='critical') must exist and be marked resolved by a staff user (SKU-AUTO-19). The flag-flip Server Action preflights this via a direct query."
- slug: sku-autonomous-phase7-live-alias-flag-and-phase8-ga
  title: "Phase 7 — live-alias autonomy flag flip; Phase 8 — GA release"
  due_date: 2026-08-15
  severity: high
  context: "Phase 7 is the 'autonomous writes reach client_store_sku_mappings' moment. Precondition: every Phase 2/3/4/5/6 gate (SKU-AUTO-*) is Active, the Bandcamp linkage for the target workspace meets the Phase 7 thresholds (70% linkage / 60% verified / 40% option — see compute_bandcamp_linkage_metrics RPC), AND the canary review queue item exists + resolved (SKU-AUTO-19). Action: the admin Server Action that sets workspaces.sku_live_alias_autonomy_enabled=true calls compute_bandcamp_linkage_metrics AND checks for resolved canary review — both block the flip. Rollout is per-workspace, one at a time, with ≥7 days between workspaces. Phase 8 (GA) removes the workspaces.sku_autonomous_*_enabled flags entirely and documents the rollout in TRUTH_LAYER + docs/system_map/INDEX.md. At GA, `sku_autonomous_emergency_paused` remains as the kill switch. The plan file (`/Users/tomabbs/.cursor/plans/autonomous_sku_matching_da557209.plan.md`) may be moved to `docs/historical/` at GA. Releasing Phase 8 is the LAST action — anything still in 'Pending-Phase-N' in RELEASE_GATE_CRITERIA.md §C.5 must be flipped to 'Active' BEFORE the flags are deleted; otherwise there is no enforcement floor for the feature post-GA."
---

# Deferred follow-ups registry

This file is parsed by the daily `deferred-followups-reminder` Trigger task
(see `src/trigger/tasks/deferred-followups-reminder.ts`). Each entry whose
`due_date <= today` causes a `warehouse_review_queue` item to be upserted (one
per workspace, deduped by `group_key`) so staff cannot forget the follow-up.

Format:

```yaml
- slug: stable-machine-readable-id      # used in group_key, never reuse
  title: "Human-readable summary"        # shown in review queue
  due_date: 2026-05-13                   # ISO date; flips to "due" when today >= this
  severity: low | medium | high | critical
  context: "Free-form context for the on-call operator."
```

Rules:
1. Once an entry is added, do **not** edit its `slug` — that breaks dedup.
2. To extend a deadline, edit `due_date` and write a brief note explaining
   the extension at the bottom of the entry's `context`.
3. To close an entry, **delete it from the YAML block** AND mark the
   corresponding `warehouse_review_queue` item resolved. Do not leave stale
   entries with past due dates — they spam the queue every morning.
4. Entries are global (not workspace-scoped) — every workspace gets a queue
   item per due entry. This is intentional: each tenant should know about the
   pending follow-up so client-facing operators can speak to it.

## Adding a new follow-up

1. Append to the YAML front matter (preserve ordering by `due_date` ascending).
2. Pick `severity` per the standard ladder: `critical` blocks production
   capacity, `high` blocks scheduled work, `medium` is "this sprint", `low` is
   maintenance.
3. Set `due_date` to the **last day** the work can wait. The cron flips to
   "due" the morning of `due_date` so the operator gets one full business day
   of warning before it lapses.
4. The next daily cron run (09:00 UTC) picks it up. No deploy needed for
   YAML-only changes.

## Closing a follow-up

1. Delete the entry from the YAML front matter in this file.
2. Run the SQL: `update warehouse_review_queue set status='resolved', resolved_at=now() where group_key='deferred-followup-<slug>';`
3. Commit the YAML change with a message of the shape: `chore(deferred): close
   <slug>`.
