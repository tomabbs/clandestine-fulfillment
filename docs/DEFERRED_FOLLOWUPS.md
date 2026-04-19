---
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
