---
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
  title: "WS3 §3f — Per-location rewrite of shipstation-v2-adjust-on-sku (SKU-total path now ships via fanout)"
  due_date: 2026-04-22
  severity: medium
  context: "Saturday Workstream 3 closeout (2026-04-18) deferred this at the §15.3 GATE per the operator's stop_at_3d decision. UPDATED 2026-04-13 (audit fix F1): the SKU-total fanout path now ships — fanoutInventoryChange() enqueues shipstation-v2-adjust-on-sku for every non-echo, non-zero recordInventoryChange() write, so FR-1 is closed for the SKU-total semantic. Severity downgraded high→medium because the operational-blocker portion is resolved. Per-location rewrite remains: operator runs the §15.3 3-case probe (single-location SKU, multi-location SKU, location with no inventory) Saturday morning and reports outcome. If v2 honors per-location writes consistently → ship the rewrite (pivot key: warehouse_inventory_levels.has_per_location_data — set automatically on first per-location write by setVariantLocationQuantity; SKUs at true route per-location, SKUs at false stay on the SKU-total path that ships today). If not → keep routing through SKU-total v2 indefinitely (already the live path); mark has_per_location_data as audit-only."
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
- slug: shipstation-stale-location-cleanup
  title: "Stale ShipStation v2 location cleanup script"
  due_date: 2026-05-21
  severity: low
  context: "After 30 days of atrophy, run scripts/cleanup-stale-ss-locations.ts to delete ShipStation locations with 0 inventory that aren't mirrored from our app. Reduces UI clutter for warehouse pickers."
- slug: migration-ordering-from-scratch
  title: "external_sync_events migration ordering bug (from-scratch deploys)"
  due_date: 2026-05-31
  severity: medium
  context: "v6 finding — external_sync_events table is referenced by indexes/views before its CREATE TABLE in the migration sequence. Fine for incrementally-migrated databases but breaks `supabase db reset`. Move CREATE TABLE earlier or split into a leading migration."
- slug: shared-utils-path
  title: "Create src/lib/shared/utils.ts canonical home for cross-cutting utilities"
  due_date: 2026-05-15
  severity: low
  context: "Rule #57 enforcement: today src/lib/utils.ts has cn() but no shared/utils.ts exists. Future formatCurrency, formatBytes, etc. must land here, not in feature folders. Migrate cn() in a follow-up to consolidate."
- slug: role-matrix-rename
  title: "Add ROLE_MATRIX export to src/lib/shared/constants.ts"
  due_date: 2026-05-15
  severity: low
  context: "Rule #40 alignment: STAFF_ROLES is exported, ROLE_MATRIX is the canonical name in CLAUDE.md/Rule #58. Add ROLE_MATRIX as the primary export and keep STAFF_ROLES as a deprecated alias for one cycle."
- slug: scanning-auth-audit
  title: "Audit src/actions/scanning.ts for explicit requireStaff() calls"
  due_date: 2026-05-15
  severity: medium
  context: "v6 finding — scanning Server Actions rely on middleware for auth instead of calling requireStaff() inline. Defense-in-depth: add requireStaff() to each action so a middleware bypass cannot escalate."
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
