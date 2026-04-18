# ShipStation as Source of Truth — Compressed Weekend Closeout Plan

**Document version:** 2.0 (restructured for review on 2026-04-13)
**Supersedes:** v1 of this document dated 2026-04-16 — preserved verbatim as **Appendix H**.
**Mirrors:** `~/.cursor/plans/megaplan_closeout_—_compressed_weekend,_manual-entry_counting_0056b39e.plan.md` (Cursor-internal plan; same content, this is the canonical full-detail review copy).
**Status:** Ready for reviewer signoff. Implementation is gated on operator approval to start the Saturday Apr 18 build.
**Hard deadline:** Tuesday Apr 21 09:00 PT (warehouse staff onboarding begins).

---

## How to read this document

The document is organized in three parts plus eight appendices. A reviewer with no prior context should be able to read Parts I–II, sample Part III for operator pacing, and use the appendices as reference.

| Section | Audience | What's inside |
|---|---|---|
| Part I (§1–§8) | Engineering reviewer | The eight required-output sections from the workspace's `prompt-pack-enforcement` rule. Scope, evidence, API/Trigger touchpoints, sequenced steps, risk/rollback, verification, doc-sync contract. |
| Part II (§9–§23) | Engineering reviewer | The standardized plan body: Feature/Goal/Context/Requirements/Constraints/Affected files/Proposed implementation/Assumptions/Risks/Validation/Rollback/Rejected alternatives/Open questions/Deferred items/Revision history. |
| Part III (§24–§32) | Operator (warehouse owner) | Plain-language summary, glossary, weekend-at-a-glance, day-by-day breakdowns Sat–Tue, halt conditions, knowingly-skipped items. |
| Appendix A | Reviewer | Consolidated indexed list of every assumption made anywhere in the plan. |
| Appendix B | Reviewer | Full source (verbatim) of the eight existing files this plan directly extends. Signature/summary for supporting files. |
| Appendix C | Reviewer | Source skeletons for every proposed new file (migrations, Trigger tasks, Server Actions, admin pages, docs). Includes the patch shape for the four existing files that get edited. |
| Appendix D | Reviewer | All 63 Supabase migration filenames with one-line descriptions; tables touched by this plan with relevant column shape; PROPOSED DDL for the two new migrations. |
| Appendix E | Reviewer | API_CATALOG.md and TRIGGER_TASK_CATALOG.md entries that need to be added/modified. |
| Appendix F | Reviewer | Deep glossary (acronyms, internal names, third-party terms). |
| Appendix G | Reviewer | Revision history of this document. |
| Appendix H | Archival | The 2026-04-16 v1 of this document, preserved verbatim. |

---

# Part I — Required Plan Output Sections

Per `.cursor/rules/prompt-pack-enforcement.mdc`, every plan must list evidence files read, identify API boundary entries, identify Trigger task entries when async/integration scope exists, and include verification steps. Sections §1–§8 below satisfy that requirement.

## §1. Scope summary

This plan delivers, in one weekend, the work required to:

1. **Close out the ShipStation v2 / Bandcamp bidirectional inventory mega-plan** (Phases 0 through 6 are SHIPPED; this is the operator-facing closeout artifact + automation that converts Phase 6 follow-ups into a recurring system smoke test).
2. **Wire ShipStation v2 as a fourth fanout target** of `recordInventoryChange()` so the existing manual-entry path on `/admin/inventory` (which already pushes to Bandcamp) also pushes to ShipStation v2 inventory.
3. **Build a locator system** (admin UI + Server Actions + ShipStation v2 location mirror) so warehouse staff can label shelves/bins on Tue/Wed and assign SKUs to those locations from inside our app, with our app being the source of truth for warehouse layout.
4. **Add per-SKU count sessions** with fanout suppression so staff can count one bin of a SKU without leaking partial totals to Bandcamp/ShipStation. Final completion fires fanout once.
5. **Rewrite the new ShipStation v2 sync-on-sku Trigger task to push per-location inventory** (not a single SKU total) so ShipStation's inventory display matches our app's per-location truth.
6. **Ramp the bridge** from `fanout_rollout_percent = 0` (today) to `100` by Monday afternoon, with two operator UX dry runs and an automated 5-SKU-per-client spot-check after each ramp step.
7. **Document and waive** the two unresolved Tier 1 hardening items (#9 Better Stack synthetic monitoring, #10 statuspage.io public status page) for 30 days so we can hit 100% Monday and onboard staff Tuesday.

The plan deliberately defers Phase 7 (dormant client-store code cleanup) by 90 days because it is a code-hygiene task with no customer-facing outcome and benefits from proving the new code path in production first.

## §2. Evidence sources (exact files read this session)

**Hard-block required reads** (per `.cursor/rules/truth-layer-hard-block.mdc`):

- `TRUTH_LAYER.md`
- `docs/system_map/INDEX.md`
- `docs/system_map/API_CATALOG.md`
- `docs/system_map/TRIGGER_TASK_CATALOG.md`
- `project_state/engineering_map.yaml`
- `project_state/journeys.yaml`
- `docs/RELEASE_GATE_CRITERIA.md`

**Existing source files inlined verbatim in Appendix B** (because this plan's new work directly extends them):

- `src/lib/server/inventory-fanout.ts` (174 lines)
- `src/lib/server/record-inventory-change.ts` (86 lines)
- `src/lib/server/external-sync-events.ts` (170 lines)
- `src/lib/server/fanout-guard.ts` (135 lines)
- `src/trigger/tasks/bandcamp-push-on-sku.ts` (337 lines)
- `src/trigger/tasks/shipstation-v2-decrement.ts` (245 lines)
- `src/lib/clients/shipstation-inventory-v2.ts` (300 lines)
- `src/app/admin/inventory/page.tsx` (504 lines)

**Existing source files read for context, summarized in Appendix B** (signature-level):

- `src/lib/shared/types.ts` (relevant excerpts)
- `src/lib/shared/env.ts` (relevant excerpts)
- `src/trigger/lib/bandcamp-queue.ts`
- `src/trigger/lib/shipstation-queue.ts`
- `src/trigger/tasks/index.ts`
- `src/actions/inventory.ts`
- `src/actions/scanning.ts`

**Migration filenames enumerated in Appendix D.1** (all 63 files in `supabase/migrations/`).

**Cursor-internal plan file the agent has been collaboratively iterating on**:

- `~/.cursor/plans/megaplan_closeout_—_compressed_weekend,_manual-entry_counting_0056b39e.plan.md` (read in full; mirrored here as the canonical review document)
- `~/.cursor/plans/b_a2a879fa.plan.md` (the upstream mega-plan that this closeout retires; ~5,934 lines, archived to `docs/archive/mega-plan-2026-04-13.md` on Mon evening per §28)

## §3. API boundaries impacted (cited from `docs/system_map/API_CATALOG.md`)

The plan modifies or adds the following API-boundary entries. New entries must be added to `API_CATALOG.md` as part of the doc-sync contract (§8).

### Server Actions (existing, extended)

| File | Action | Change |
|---|---|---|
| `src/actions/inventory.ts` | `adjustInventory(sku, delta, reason)` | No signature change. Behavior unchanged. New side-effect: `recordInventoryChange()` now also enqueues `shipstation-v2-adjust-on-sku` via the extended `fanoutInventoryChange()` (audit fix F1, 2026-04-13 — actual task name is `-adjust-on-sku` because it handles BOTH delta directions; the original plan name `-sync-on-sku` is preserved in the deferred §3f / §15.3 / §15.6 sections that describe the per-location rewrite). |
| `src/actions/inventory.ts` | `getTodayCountProgress()` | **NEW**. Returns `{ totalChangesToday: number, totalChangesByMe: number }` for the Inventory page header chip. Reads `warehouse_inventory_activity` filtered to today + `source IN ('manual', 'cycle_count', 'manual_inventory_count')`. |

### Server Actions (new files)

| File | Actions exported |
|---|---|
| `src/actions/megaplan-spot-check.ts` | `triggerSpotCheck()`, `listSpotCheckRuns(limit?)`, `getSpotCheckArtifact(runId)` |
| `src/actions/locations.ts` | `listLocations({ activeOnly?, search? })`, `createLocation({ name, type, barcode? })`, `createLocationRange({ prefix, fromIndex, toIndex, type, padWidth? })`, `updateLocation(id, patch)`, `deactivateLocation(id)`, `retryShipstationLocationSync(locationId)` |
| `src/actions/inventory-counts.ts` | `startCountSession(sku)`, `setVariantLocationQuantity({ sku, locationId, quantity })`, `completeCountSession(sku)`, `cancelCountSession(sku, { rollbackLocationEntries })`, `getCountSessionState(sku)` |

### Route handlers (no changes)

This plan adds zero new HTTP routes. The ShipStation `SHIP_NOTIFY` webhook (`src/app/api/webhooks/shipstation/route.ts`) is unchanged. The client-store webhook handler is unchanged. The Bandcamp side has no inbound webhooks (Bandcamp doesn't expose any).

### External APIs called

| External system | Endpoint | Caller | Change |
|---|---|---|---|
| ShipStation v2 | `POST /v2/inventory` (transaction_type: `decrement`) | `shipstation-v2-decrement` task | None — already shipped Phase 4. |
| ShipStation v2 | `POST /v2/inventory` (transaction_type: `modify`) | `shipstation-v2-sync-on-sku` task | **NEW**. Per-location absolute quantity assertions for inventory counts. |
| ShipStation v2 | `GET /v2/inventory` | `shipstation-bandcamp-reconcile-{hot,warm,cold}` tasks | None — already shipped Phase 5. |
| ShipStation v2 | `POST /v2/inventory_locations` | `createLocation()` Server Action | **NEW**. Mirrors local location creation to ShipStation. |
| ShipStation v2 | `PUT /v2/inventory_locations/{id}` | `updateLocation()` Server Action | **NEW**. Mirrors local rename to ShipStation. |
| ShipStation v2 | `DELETE /v2/inventory_locations/{id}` | (defined but not auto-called) | **NEW**. Available for manual cleanup script later. |
| Bandcamp | `update_quantities` | `bandcamp-push-on-sku` task | None — already shipped Phase 4. |

## §4. Trigger touchpoint check (per `truth-layer-hard-block.mdc`)

Because this plan's scope touches **inventory, sync, and integrations**, a Trigger touchpoint section is mandatory. The following Trigger task IDs were reviewed; the new tasks below must be added to `docs/system_map/TRIGGER_TASK_CATALOG.md` as part of the doc-sync contract (§8).

### Existing tasks reviewed (no behavior change)

| Task ID | Queue | Schedule | Reviewed for |
|---|---|---|---|
| `bandcamp-sale-poll` | `bandcamp-api` | every 5 min | Confirmed it triggers `shipstation-v2-decrement` correctly (Phase 4). |
| `bandcamp-push-on-sku` | `bandcamp-api` | event-driven | Mirror reference for `shipstation-v2-adjust-on-sku` (shipped) / per-location rewrite (deferred §3f). Source inlined Appendix B.5. |
| `shipstation-v2-decrement` | `shipstation` | event-driven | Mirror reference. Source inlined Appendix B.6. |
| `shipstation-bandcamp-reconcile-hot` | `shipstation` | every 5 min | No change. Will pick up new per-location writes via existing reconcile logic. |
| `shipstation-bandcamp-reconcile-warm` | `shipstation` | every 30 min | No change. |
| `shipstation-bandcamp-reconcile-cold` | `shipstation` | every 6 hr | No change. |
| `process-shipstation-shipment` | `shipstation` | event-driven | No change. Continues to call `recordInventoryChange()` on shipment events. **Updated 2026-04-13 (audit fix F1):** the SHIP_NOTIFY-originated write does NOT propagate to ShipStation v2 — the source is `'shipstation'` and `fanoutInventoryChange()` echo-skips that source per Rule #65 (otherwise we would double-decrement what ShipStation just decremented locally). It still propagates to Bandcamp via existing `bandcamp-push-on-sku`. The per-location refresh via `shipstation-v2-sync-on-sku` (the original plan name; deferred per §3f / §15.3) is no longer required because the `'modify new_available'` no-op-write strategy is now obsolete — `adjust on sku` uses delta arithmetic and skipping is correct. |
| `bandcamp-inventory-push` | `bandcamp-api` | every 5 min | Cron path unchanged. Continues to handle bundles + option-level mappings. |
| `multi-store-inventory-push` | various per-platform | every 5 min | Unchanged. |
| `external-sync-events-retention` | default | daily | Existing 7-day retention sweeper continues to apply; no schema change. |

### New tasks introduced by this plan

| Task ID | Queue | Schedule | Purpose |
|---|---|---|---|
| `shipstation-v2-adjust-on-sku` (originally planned as `shipstation-v2-sync-on-sku`) | `shipstation` | event-driven (enqueued by `fanoutInventoryChange` AND by `submitManualInventoryCounts`) | Per-SKU push to ShipStation v2 inventory. Behavior phased: SKU-total path **shipped 2026-04-13 (audit fix F1)** — see Part IV "Post-audit fixes". Per-location rewrite remains deferred per §3f / §15.3 GATE. Skeleton in Appendix C.5 describes the deferred per-location form (uses `transaction_type:'modify' new_available:N`); shipped form uses `'increment'/'decrement' quantity:|delta|` per Phase 0 Patch D2. |
| `megaplan-spot-check` | `shipstation` | hourly during ramp weekend, then daily | Samples 5 SKUs per active client (~85 SKUs), reads each from DB / Redis / ShipStation v2 / Bandcamp, classifies drift, writes a `megaplan_spot_check_runs` row, creates a `warehouse_review_queue` item if any `drift_major` rows. Skeleton in Appendix C.3. |
| `deferred-followups-reminder` | default (low-priority) | daily at 09:00 ET | Parses `docs/DEFERRED_FOLLOWUPS.md`, creates a `warehouse_review_queue` item for each entry whose `due_date <= today`, idempotent via `correlation_id = 'deferred:{slug}:{due_date}'`. Skeleton in Appendix C.4. |

### Queue serialization (Rule #9 / Tier 1 #1)

All new ShipStation v2 traffic (`shipstation-v2-adjust-on-sku` — shipped name; planned as `shipstation-v2-sync-on-sku`; location create/update calls inside Server Actions) routes through `shipstationQueue` (`concurrencyLimit: 1`). The Server Action ShipStation calls happen **inline** in the action body (not via Trigger), so they bypass the queue — but the volume is bounded (one call per location create, max ~50/day during the Tue/Wed labeling burst) and the calls are sequential within the action. This is documented as a constraint in §13.

Bandcamp serialization is unchanged: `bandcamp-push-on-sku` and `bandcamp-sale-poll` both pin to `bandcamp-api` queue.

## §5. Proposed implementation steps (sequenced)

The full sequenced timeline is in Part III §27–§30. The condensed engineering view:

1. **Saturday 09:00–15:00** — Workstream 1 (closeout): migration 40 + spot-check task + Server Actions + admin verification page + reminder cron + DEFERRED_FOLLOWUPS registry + verification artifact pre-fill + Phase-6 cleanup batch. ~6 hr.
2. **Saturday 15:00–19:00** — Workstream 2 (basic ShipStation v2 fanout): migration 50 + types + fanout extension + initial `shipstation-v2-sync-on-sku` task (SKU-total path) + tests. ~4 hr.
3. **Saturday 19:00–06:30 Sunday** — Workstream 3 (locator + count session + ShipStation mirror): ShipStation v2 client extensions + `locations.ts` + `inventory-counts.ts` + Locations admin page + Inventory page expanded-row count UI + per-location rewrite of `shipstation-v2-sync-on-sku` + tests. ~11.5 hr. (See §17 risks for fallback priority if this slips.)
4. **Saturday 06:30–07:00 Sunday** — `pnpm release:gate` + `supabase db push --yes` + Vercel deploy. Bridge stays at `fanout_rollout_percent = 0`. ~30 min.
5. **Sunday 07:30–09:30** — UX polish: toast + row highlight + Set-to dialog toggle + daily count-progress chip + `getTodayCountProgress()` Server Action + redeploy. ~2.25 hr.
6. **Sunday 10:00 / 12:00 / 14:00 / 16:00 / 18:00** — Operator UX dry run #1 (~25 min); ramp 0→10%; checkpoint; ramp 10→50%; checkpoint.
7. **Monday 09:00 / 14:00–15:00 / 17:00** — Checkpoint; ramp 50→100%; spot-check; operator UX dry run #2 with real shelves (~45 min); final spot-check; operator signs Section E of verification artifact; agent moves mega-plan to `docs/archive/`; reminder cron enabled.
8. **Tuesday 09:00** — Staff arrive; bridge live at 100%; manual visual counts on `/admin/inventory` using locator + count session UI.

## §6. Risk + rollback notes

Top-five risks (full risk register in §17, full rollback plan in §19):

| # | Risk | Severity | Detection | Mitigation / rollback |
|---|---|---|---|---|
| 1 | Count session fanout suppression bug leaks partial counts to Bandcamp/ShipStation → oversell | Critical | UX dry run #1 Part B canary; unit test in `inventory-counts.test.ts`; spot-check artifact flags drift on `count_in_progress` SKUs | Set `inventory_sync_paused = true` (existing global kill switch); per-SKU partial counts stay local until next session completes |
| 2 | Saturday ~22 hr build day slips, Workstream 3 unfinished | Medium | Operator checks at midpoint | Documented fallback priority in §15; if locator UI doesn't ship, count session backend + plain Avail-cell flow still let staff count Tue/Wed (lower fidelity but functional) |
| 3 | ShipStation v2 rate-limit during 100% ramp + count burst | Medium | `shipstation` queue concurrency = 1; v2 5xx rate sensor halts at 2% in 30 min | Set `shipstation_sync_paused = true` (per-integration kill switch); fanout queues drain when unpaused |
| 4 | ShipStation location mirror failure leaves SKUs unsynced | Medium | `shipstation_sync_error` column populated; failure-rate sensor halts new creates at >10% in 60 min | Local row keeps working; per-location ShipStation writes skip null IDs and queue retry; daily reconcile sensor catches drift |
| 5 | UX dry run #2 reveals staff pace too slow (>90s/SKU) | Medium | Operator reports per-shelf time | Triage 3 hr window before signoff; fall back to Avail-cell-only for single-bin SKUs; multi-bin counts continue across the week |

Full rollback plan in §19. Three escape hatches summarized:
- **Per-integration pause:** `UPDATE workspaces SET shipstation_sync_paused = true WHERE id = ?;` (covers ShipStation v2 fanout + location mirror writes; doesn't affect ShipStation v1 alias path which is on a separate kill switch).
- **Global pause:** `UPDATE workspaces SET inventory_sync_paused = true WHERE id = ?;` (stops ALL outbound fanout; Redis + Postgres still update).
- **Ramp reversal:** `UPDATE workspaces SET fanout_rollout_percent = 0 WHERE id = ?;` (preserves the kill switches as off but routes 0% of traffic).

## §7. Verification steps

Mandatory (gate the Sunday ramp):

1. `pnpm typecheck` clean.
2. `pnpm test` — all unit tests pass, including the seven new test files listed in §15.
3. `pnpm check` — Biome lint/format clean.
4. `pnpm build` — production Next.js build succeeds (catches Server Action / route segment regressions).
5. `pnpm release:gate` — composite gate (typecheck + test + build + biome + the inventory write-path lint guard from Rule #42 + the v2 batch-only lint guard from `scripts/check-v2-inventory-batch.sh`).
6. `supabase migration list --linked` shows migrations 40 and 50 applied to the linked Supabase project.
7. Vercel deploy succeeds (production).
8. First manual `triggerSpotCheck()` returns `summary.drift_major_count = 0` (or operator-acknowledged baseline drift).
9. UX dry run #1 (Sun 10:00) Part A and Part B both pass.
10. Spot-check after each ramp step (10%, 50%, 100%) returns zero `drift_major` rows.

Optional but expected:

11. Reconcile sensor health page (`/admin/settings/shipstation-inventory`) shows green for hot/warm/cold tiers.
12. Sentry shows no new exception classes in the `inventory.fanout` or `inventory-counts.*` spans during the ramp window.

## §8. Doc Sync Contract updates required

Per `.cursor/rules/prompt-pack-enforcement.mdc` "Doc Sync Contract (Mandatory)", the following truth-layer documents MUST be updated in the same session that ships the code:

| Concern | Document | Change |
|---|---|---|
| Architecture / ownership | `TRUTH_LAYER.md` | Add three invariants: (a) "the spot-check Trigger task is the canonical operator-facing system smoke test; calendar-based reminder cron surfaces deferred work into the review queue", (b) "during a count session (`warehouse_inventory_levels.count_status = 'count_in_progress'`), per-location quantity writes do NOT enqueue fanout — only `completeCountSession()` does", (c) "our app is the source of truth for warehouse locations; ShipStation v2 location records are mirrored from `warehouse_locations` only — there is no reverse sync". |
| Architecture / ownership | `project_state/engineering_map.yaml` | Add `inventory.locator` domain (owners: warehouse + integrations) covering `src/actions/locations.ts`, `src/actions/inventory-counts.ts`, `src/app/admin/settings/locations/page.tsx`. Mark `inventory.fanout` updated with the new ShipStation target. |
| Behavior / journey | `project_state/journeys.yaml` | Add `journey.label_and_count_baseline` (staff labels shelf → creates location inline → starts count → enters per-location qtys → completes → fanout fires once). Add `journey.shipstation_location_mirror` (createLocation → POST /v2/inventory_locations → store ID → subsequent per-location writes target the mirrored ID). |
| API boundary | `docs/system_map/API_CATALOG.md` | Add the 9 Server Actions listed in §3 ("new files" subsection) and the 3 ShipStation v2 client functions (`createInventoryLocation`, `updateInventoryLocation`, `deleteInventoryLocation`). |
| Trigger wiring | `docs/system_map/TRIGGER_TASK_CATALOG.md` | Add the three new tasks listed in §4 ("new tasks" subsection) with their queue, schedule, and idempotency key shape. |
| Release verification policy | `docs/RELEASE_GATE_CRITERIA.md` | Add the spot-check artifact requirement (`drift_major_count = 0` after each ramp step) to Section D manual checks. Document the Tier 1 #9 / #10 waiver expiration date (2026-05-13) in the deferred-items appendix. |
| Code conventions | `CLAUDE.md` | Add Rule #73 (`vi.resetAllMocks()` over `vi.clearAllMocks()` for tests using `mockReturnValueOnce`), Rule #74 (count session fanout suppression invariant), Rule #75 (no direct ShipStation location creation outside `createLocation()` Server Action). |

The Cursor rule explicitly says: *"Do not mark work complete if required doc updates are missing."* The Mon 17:00 signoff checkpoint includes a doc-sync verification step.

---

# Part II — Standardized Plan Body

The fifteen sections below follow the Patch C standardized template established in the upstream mega-plan (§14.8). They restate the same content as Part I in the structured "Feature/Goal/Context/…/Revision history" shape that engineering reviewers expect.

## §9. Feature

A weekend closeout package that converts the in-progress ShipStation v2 / Bandcamp bidirectional inventory mega-plan into a production-ready operational baseline by Tuesday 09:00 PT, including:

- Manual-entry inventory counting from `/admin/inventory` that propagates to Bandcamp **and** ShipStation v2 (today only Bandcamp).
- A locator system (warehouse locations) with admin UI, Server Actions, and one-way mirror to ShipStation.
- Per-SKU count sessions that suppress partial-count fanout to prevent oversells during multi-bin counting.
- Per-location ShipStation v2 inventory writes (vs. today's single-SKU-total writes).
- Hourly automated spot-check Trigger task + admin verification page.
- Calendar-based reminder cron for deferred work (Phase 7, Tier 1 #9, Tier 1 #10).
- Signed verification artifact (`docs/MEGA_PLAN_VERIFICATION_2026-04-13.md`) and mega-plan archival.

## §10. Goal

By Tue Apr 21 09:00 PT, all of the following are true:

- Warehouse staff can open `/admin/inventory`, label a physical shelf, create the matching location record inline, start a count session for any SKU, enter per-location quantities, complete the count, and have the final SKU total propagate to Bandcamp + ShipStation v2 within 60 seconds.
- The `fanout_rollout_percent` for the Clandestine workspace is at 100, gated by the new per-integration ShipStation kill switch and the existing global pause.
- A daily spot-check task is running, surfacing any drift > 0 SKUs to the warehouse review queue.
- The mega-plan (`~/.cursor/plans/b_a2a879fa.plan.md`) has been moved to `docs/archive/mega-plan-2026-04-13.md` and the operator has signed `docs/MEGA_PLAN_VERIFICATION_2026-04-13.md` Section E (including waiver text for Tier 1 #9 + #10).
- A daily `deferred-followups-reminder` cron is enabled and will surface review-queue items for Phase 7 (due 2026-07-13), Tier 1 #9 (due 2026-05-13), Tier 1 #10 (due 2026-05-13), and `external_sync_events` retention verification (due 2026-04-25).

The goal **explicitly does NOT include**:

- Scanner-based count flow (deferred until physical hardware arrives).
- Active deletion of stale ShipStation v2 locations (atrophy strategy).
- Better Stack synthetic monitoring (deferred 30 days).
- statuspage.io public status page (deferred 30 days).
- Phase 7 dormant client-store code cleanup (deferred 90 days).
- Bidirectional ShipStation→our-app location sync (one-way only this weekend).

## §11. Context

**Today's state (2026-04-13).** The mega-plan to make ShipStation v2 the source of truth for inventory is shipped through Phase 6:

- Phase 0 (env + Patch D2 probe) — SHIPPED.
- Phase 0.5 (SKU rectify infrastructure: `external_sync_events`, alias mutex, daily audit) — SHIPPED.
- Phase 1 (baseline anomaly audit + `push_mode` enum) — SHIPPED.
- Phase 2 (ShipStation v2 client + SHIP_NOTIFY processor + batch-read CI guard) — SHIPPED.
- Phase 3 (seed task + admin) — SHIPPED.
- Phase 4 (bidirectional bridge: `shipstation-v2-decrement` + `bandcamp-push-on-sku` + per-workspace rollout column) — SHIPPED.
- Phase 5 (tiered reconcile + `sku_sync_status` view + monitoring page) — SHIPPED.
- Phase 6 (validation drill: pre-existing test fixes + automated gates green) — SHIPPED.

**The bridge is wired but not active.** All Clandestine workspaces have `fanout_rollout_percent = 0`. The pre-Phase-6 expectation was a multi-day burn-in followed by a graduated ramp. The operator has compressed that timeline because warehouse staff onboard Tuesday Apr 21 and they need live inventory entry by then.

**The functional gap that blocks staff onboarding.** `recordInventoryChange()` calls `fanoutInventoryChange()` which currently fans out to three targets: Clandestine Shopify, client stores (via `multi-store-inventory-push`), and Bandcamp (via `bandcamp-inventory-push`). It does **not** currently fan out to ShipStation v2. So when a staff member edits the Avail cell on `/admin/inventory`, Bandcamp updates within minutes but ShipStation v2 still shows the old number. ShipStation is the source of truth for everything except Bandcamp; the asymmetry is unworkable for live counting.

**The locator gap.** The schema has `warehouse_locations` and `warehouse_variant_locations` tables (created in `20260316000003_inventory.sql`) but no UI ever shipped. Staff need to label shelves Tuesday and assign SKUs to those labels. Staff also need ShipStation's pick-list view to show the same labels (because warehouse staff pick from ShipStation's UI, not ours, when fulfilling). The legacy ShipStation location data is stale and incomplete; the operator wants our app to overwrite it through new per-location writes.

**The count semantic problem.** If we naively allow per-location quantity edits to fire fanout, a staff member counting 30 LPs in Bin A while 20 are still in Bin B (uncounted) would push 30 to Bandcamp, which would then start overselling. The fix is a per-SKU "count session" state that suppresses fanout until the count is explicitly completed.

**Why this is one weekend.** Workstreams 1 and 2 are linear and well-defined (closeout admin UI; basic ShipStation v2 fanout). Workstream 3 (locator + count session + ShipStation mirror) is large but can be subdivided into independently shippable pieces (see §15). The hard deadline is non-negotiable (staff offer letter signed, training scheduled).

## §12. Requirements

### §12.1. Functional requirements

**FR-1.** When a staff member edits the Avail cell on `/admin/inventory`, the new value MUST propagate to Bandcamp AND ShipStation v2 within 60 seconds (subject to the existing fanout-guard rollout percentage).

**FR-2.** Staff MUST be able to create a warehouse location from `/admin/inventory` without leaving the page (inline typeahead + "Create new" affordance inside the count session UI).

**FR-3.** Staff MUST be able to bulk-create a range of locations from the Locations admin page (e.g. `A-12-01` through `A-12-50` in one action).

**FR-4.** Each location MUST be mirrored to ShipStation v2 via `POST /v2/inventory_locations` and the returned `inventory_location_id` MUST be stored on the local row.

**FR-5.** When a staff member starts a count session for a SKU, subsequent per-location quantity writes for that SKU MUST NOT enqueue fanout to Bandcamp or ShipStation. Sales and shipments still flow normally during a count session.

**FR-6.** When a staff member completes a count session, the final SKU total (sum of per-location quantities) MUST be persisted via `recordInventoryChange()` so fanout fires exactly once.

**FR-7.** When a staff member cancels a count session with `rollbackLocationEntries: true`, all per-location rows touched during the session MUST be reverted to their pre-session state.

**FR-8.** The new `shipstation-v2-sync-on-sku` Trigger task MUST write per-location absolute quantities (not a single SKU total) when per-location data exists for a SKU. SKUs without per-location data fall back to a single workspace-default-location write.

**FR-9.** A new `megaplan-spot-check` Trigger task MUST sample 5 SKUs per active client, classify drift across DB / Redis / ShipStation v2 / Bandcamp, persist a row in `megaplan_spot_check_runs`, and create a `warehouse_review_queue` item if any `drift_major` rows exist.

**FR-10.** A new `deferred-followups-reminder` Trigger cron MUST parse `docs/DEFERRED_FOLLOWUPS.md` daily and create a `warehouse_review_queue` item per entry whose `due_date <= today`, idempotent on `correlation_id`.

### §12.2. Non-functional requirements

**NFR-1. Single inventory write path.** Per Rule #20: ALL inventory changes flow through `recordInventoryChange()`. The new count session logic complies — `completeCountSession()` calls `recordInventoryChange({ source: 'cycle_count', ... })`. Per-location writes during in-progress sessions write directly to `warehouse_variant_locations` (which is the per-location detail table, not the SKU-total table) and explicitly do NOT touch `warehouse_inventory_levels.available`.

**NFR-2. External mutation idempotency.** Every external API mutation (ShipStation v2 inventory writes, ShipStation v2 location create/update, Bandcamp push) MUST flow through the `external_sync_events` ledger via `beginExternalSync` / `markExternalSyncSuccess` / `markExternalSyncError`.

**NFR-3. Queue serialization.** Bandcamp OAuth (Rule #9) and ShipStation v2 (Tier 1 #1) MUST stay serialized. Trigger tasks pin to the appropriate shared queue. Server Actions that call ShipStation v2 inline (location create/update) accept that they bypass the queue but justify it by bounded volume + sequential within-action calls.

**NFR-4. Webhook latency.** Existing webhook handler (`/api/webhooks/shipstation`) is unchanged. It already returns 200 OK in under 500ms by enqueueing `process-shipstation-shipment` and not doing inline work.

**NFR-5. Server Action timeouts.** Per Rule #41/#54: count session Server Actions stay under 30 seconds. The longest-path action (`completeCountSession`) does (a) sum, (b) RPC `record_inventory_change_txn`, (c) trigger fanout (fire-and-forget). Estimated p95 < 2 seconds. No `maxDuration` override needed.

**NFR-6. Connection pooling.** All new Server Actions and Trigger tasks use the existing `createServiceRoleClient()` / `createServerSupabaseClient()` factories from `src/lib/server/supabase-server.ts` (note `createServerSupabaseClient` is async — call sites must `await` it). Both already point at Supavisor port 6543 (Rule #67). The plan does NOT introduce a `createServerActionClient` symbol; that name appeared in earlier drafts as a misremembered alias and was renamed in the v6 codebase verification pass.

**NFR-7. Database trigger preservation.** The `derive_inventory_org_id` trigger on `warehouse_inventory_levels` (Rule #21) MUST continue to auto-populate `org_id` from variant → product. The new `count_status` columns are added without modifying the trigger.

**NFR-8. Frozen primitives.** Per Rule #11/#38, Wave 1 frozen files (types.ts, middleware.ts, supabase-server.ts, layout files) are touched ONLY in additive ways. `types.ts` extension adds new union members and new interface fields, never removes or renames.

**NFR-9. Audit trail.** Every count session completion writes a `warehouse_inventory_activity` row with `source: 'cycle_count'` and a stable correlation ID `count-session:{sessionId}:{sku}` so the activity log is queryable by session.

## §13. Constraints

### §13.1. Technical

- **TC-1.** ShipStation v2 location create/update calls in Server Actions are NOT serialized through `shipstationQueue` (because they happen inline in the action body, not in a Trigger task). Acceptable because (a) the call is sequential within the action; (b) volume is bounded — at most ~50 location creates during the Tue/Wed labeling burst; (c) per-Server-Action latency budget tolerates the synchronous v2 call (< 1s typical). If load profile changes (>200 location creates/day), refactor to enqueue a `shipstation-mirror-location` Trigger task.
- **TC-2.** `decrement quantity: 0` to ShipStation v2 returns 200 (Patch D2 probe), `modify new_available: 0` returns 400. The `shipstation-v2-sync-on-sku` per-location rewrite uses `transaction_type: 'modify' new_available: per_location_qty` for non-zero quantities and falls back to `adjust quantity: 0` for the zero case. This client-side validation is already enforced by `adjustInventoryV2()` (Appendix B.7).
- **TC-3.** Vercel Server Action body limit is 4.5MB (Rule #68). All new Server Actions return small responses (< 100KB). No file upload paths added.
- **TC-4.** PostgREST `from().update()` followed by `from().insert()` is NOT a transaction (Rule #64). The count session `completeCountSession` action uses the existing `record_inventory_change_txn` RPC for the level update + activity insert. Per-location writes during in-progress are single-row upserts on `warehouse_variant_locations` and don't need transaction wrapping (a partial write here is recoverable on next session attempt).
- **TC-5.** Redis HINCRBY is not idempotent (Rule #47). All inventory-mutating writes route through `adjustInventory()` which already uses SETNX + Lua script. Per-location writes during in-progress sessions do NOT call Redis (they don't change SKU totals); only `completeCountSession` does, and it routes through `recordInventoryChange()`.

### §13.2. Product

- **PC-1.** Operator has explicitly accepted the ~22-hour Saturday agent build day risk with no scope cuts. Documented fallback priority order in §15.6.
- **PC-2.** Tier 1 #9 (Better Stack) and #10 (statuspage.io) waivers are accepted with a 30-day expiration. The operator manually monitors during the first week.
- **PC-3.** Phase 7 dormant code cleanup is deferred 90 days to validate the new code path in production first.
- **PC-4.** Stale ShipStation v2 locations are NOT actively deleted this weekend. They atrophy as their inventory hits 0.

### §13.3. External

- **EC-1.** Bandcamp does not provide inventory webhooks; all Bandcamp inventory state is push-only from our side via `update_quantities`. The 5-minute `bandcamp-inventory-push` cron remains the primary cadence; `bandcamp-push-on-sku` is the focused-push fast path.
- **EC-2.** ShipStation v2 has no inventory webhook (only `SHIP_NOTIFY` shipment webhook). All ShipStation→our-app inventory awareness is poll-based via the reconcile tiers.
- **EC-3.** ShipStation v2 rate limit is ~60 req/min; Phase 0 set the operating budget at 50% utilization (~30 req/min) to leave headroom for bursts. The `shipstationQueue concurrencyLimit: 1` plus per-call latency keeps us well under.
- **EC-4.** ShipStation v2 location resource shape varies slightly between API versions; the existing client (`listInventoryLocations`) normalizes defensively. New `createInventoryLocation` follows the same pattern.

## §14. Affected files

This is the canonical list. Cross-reference with §15 for behavior changes per file.

### §14.1. New files (19)

| Path | Purpose |
|---|---|
| `supabase/migrations/20260413000040_megaplan_spot_check_runs.sql` | Spot-check artifact storage |
| `supabase/migrations/20260418000001_phase4b_megaplan_closeout_and_count_session.sql` (planned filename `20260413000050_phase4b_shipstation_fanout.sql`; renamed during WS1 build because the same migration also bundled spot-check + count-session schema) | ShipStation kill-switch column + count_status columns + new InventorySource values (`cycle_count`, `manual_inventory_count`) + ShipStation location mirror columns |
| `src/trigger/tasks/megaplan-spot-check.ts` | Hourly spot-check task |
| `src/trigger/tasks/deferred-followups-reminder.ts` | Daily reminder cron |
| `src/trigger/tasks/shipstation-v2-adjust-on-sku.ts` (planned as `shipstation-v2-sync-on-sku.ts`) | Per-SKU push to ShipStation v2. Shipped form: SKU-total via `increment`/`decrement` (audit fix F1, 2026-04-13). Per-location semantics deferred per §3f / §15.3. |
| `src/actions/megaplan-spot-check.ts` | Server Actions for the verification admin page |
| `src/actions/locations.ts` | Server Actions for location CRUD + ShipStation mirror |
| `src/actions/inventory-counts.ts` | Server Actions for count sessions |
| `src/app/admin/settings/megaplan-verification/page.tsx` | Admin page listing spot-check runs + signed artifact link |
| `src/app/admin/settings/locations/page.tsx` | Admin page for location CRUD + sync status |
| `tests/unit/trigger/megaplan-spot-check.test.ts` | Unit tests for the spot-check task |
| `tests/unit/trigger/deferred-followups-reminder.test.ts` | Unit tests for the reminder cron |
| `tests/unit/trigger/shipstation-v2-adjust-on-sku.test.ts` (planned name `shipstation-v2-sync-on-sku.test.ts`) | Unit tests for the per-SKU push. **Note (2026-04-13):** the shipped task currently exercises its skip cascade (incl. inventory_sync_paused, audit fix F3) via the inline tests in `tests/unit/actions/manual-inventory-count.test.ts` and the new echo/pause-skip logic tests in `tests/unit/lib/server/inventory-fanout.test.ts`. A dedicated `shipstation-v2-adjust-on-sku.test.ts` is a follow-up if/when the per-location rewrite ships. |
| `tests/unit/actions/megaplan-spot-check.test.ts` | Unit tests for the spot-check Server Actions |
| `tests/unit/actions/locations.test.ts` | Unit tests for location Server Actions (incl. ShipStation mirror failure path) |
| `tests/unit/actions/inventory-counts.test.ts` | Unit tests for count session Server Actions (incl. fanout suppression invariant) |
| `tests/unit/lib/inventory-fanout.test.ts` | Extends or creates fanout target test (asserts all 4 targets fire) |
| `docs/DEFERRED_FOLLOWUPS.md` | Registry of deferred items with due dates |
| `docs/MEGA_PLAN_VERIFICATION_2026-04-13.md` | One-time verification artifact (Sections A–E) |

### §14.2. Edited files (12)

| Path | Change summary |
|---|---|
| `src/lib/shared/types.ts` | Add `'shipstation'` to `IntegrationKillSwitchKey`. Add `'cycle_count'` and `'manual_inventory_count'` to `InventorySource`. Add `CountStatus` type and extend `WarehouseInventoryLevel` interface. Add `shipstation_inventory_location_id`, `shipstation_synced_at`, `shipstation_sync_error` fields to `WarehouseLocation` interface. |
| `src/lib/clients/shipstation-inventory-v2.ts` | Add `createInventoryLocation`, `updateInventoryLocation`, `deleteInventoryLocation`. |
| `src/lib/server/inventory-fanout.ts` | Add ShipStation v2 as a fourth fanout target — **shipped 2026-04-13 (audit fix F1)**. New code reads variant/sku, evaluates `guard.shouldFanout('shipstation', correlationId)`, enqueues `tasks.trigger('shipstation-v2-adjust-on-sku', {...})` (planned name was `-sync-on-sku`; shipped name handles BOTH delta directions). Bundles still excluded (existing logic). Source-based echo skip for `'shipstation'` and `'reconcile'` per Rule #65 (audit fix F1). Also adds a top-of-function `inventory_sync_paused` short-circuit (audit fix F2). Distros: not filtered here — same behavior as the pre-existing Bandcamp/Shopify fanout. |
| `src/trigger/tasks/index.ts` | Register the three new tasks (spot-check, reminder, shipstation-v2-adjust-on-sku — registered under that name). |
| `src/app/admin/inventory/page.tsx` | Toast feedback on inline-edit save. Recently-edited row highlight (CSS transition). Set-to toggle in the Adjust dialog. Daily count-progress chip near Export CSV. Expanded-row count session UI panel (Start count / per-location editable list with inline location create / Complete / Cancel). |
| `src/actions/inventory.ts` | Add `getTodayCountProgress()` Server Action. |
| `tests/unit/lib/billing-rates.test.ts` | Phase 6 cleanup carry-over: replace 3x `supabase as any` with proper typed mocks; remove unused `beforeEach` import. |
| `docs/system_map/TRIGGER_TASK_CATALOG.md` | Add three new tasks (per §4 + §8). |
| `docs/system_map/API_CATALOG.md` | Add 9 Server Actions and 3 ShipStation client functions (per §3 + §8). |
| `project_state/engineering_map.yaml` | Add `inventory.locator` domain; mark `inventory.fanout` updated. |
| `project_state/journeys.yaml` | Add `journey.label_and_count_baseline` and `journey.shipstation_location_mirror`. |
| `TRUTH_LAYER.md` | Three new invariants (per §8). |
| `CLAUDE.md` | Three new rules (#73, #74, #75) (per §8). |

### §14.3. Archived files (1)

| Path | Destination |
|---|---|
| `~/.cursor/plans/b_a2a879fa.plan.md` (mega-plan, ~5,934 lines) | `docs/archive/mega-plan-2026-04-13.md` (Mon 17:00 after operator signoff) |

### §14.4. Deleted files (0)

This plan deletes nothing. The dormant `/admin/scan` UI and the `submitCount` Server Action stay in place pending Phase 7 (deferred 90 days).

## §15. Proposed implementation

This section is the engineering-detail expansion of §5. For operator pacing and minute-by-minute schedule see §27–§30.

### §15.1. Workstream 1 — closeout deliverables (~6 hr Sat)

**Migration 40** (`20260413000040_megaplan_spot_check_runs.sql`). Creates `megaplan_spot_check_runs` table:

```sql
create table megaplan_spot_check_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  sampled_sku_count integer not null default 0,
  drift_agreed_count integer not null default 0,
  drift_minor_count integer not null default 0,
  drift_major_count integer not null default 0,
  delayed_propagation_count integer not null default 0,
  summary_json jsonb not null default '{}'::jsonb,
  artifact_md text,
  created_by uuid references users(id)
);
create index megaplan_spot_check_runs_started_idx on megaplan_spot_check_runs (started_at desc);
alter table megaplan_spot_check_runs enable row level security;
create policy "staff_select_megaplan_spot_check_runs"
  on megaplan_spot_check_runs for select to authenticated using (is_staff_user());
```

**Trigger task** (`src/trigger/tasks/megaplan-spot-check.ts`). Skeleton in Appendix C.3. Behavior:

1. Insert a `megaplan_spot_check_runs` row with `started_at = now()`.
2. For each active workspace (one in our case): fetch 5 SKUs that satisfy "active variant, has Bandcamp mapping, has a `warehouse_inventory_levels` row".
3. Per SKU: read DB.available, Redis available via `getInventoryLevel`, ShipStation v2 via `listInventory({ skus: [sku] })`, Bandcamp pushed value via `bandcamp_product_mappings.bandcamp_origin_quantities`.
4. Classify: `agreed` (all 4 match), `delayed_propagation` (Redis matches DB, ShipStation/Bandcamp differ but `last_pushed_at < 5 min ago`), `drift_minor` (≤ 2 unit diff with last_pushed > 5 min), `drift_major` (> 2 unit diff or any system unreachable).
5. Update the run row with counts + `summary_json` (per-SKU rows) + `artifact_md` (rendered markdown table).
6. If `drift_major_count > 0`, create a `warehouse_review_queue` item with `severity: 'critical'`, `assigned_to: null`, `group_key: 'megaplan-spot-check-drift-major'` (auto-dedup increments `occurrence_count`).

Pinned to `shipstationQueue` (concurrencyLimit: 1). Schedule: `cron("0 * * * *")` during ramp weekend, then operator switches to `cron("0 9 * * *")` Tuesday morning.

**Server Actions** (`src/actions/megaplan-spot-check.ts`):

- `triggerSpotCheck()` — calls `tasks.trigger('megaplan-spot-check', {})`, returns the run ID.
- `listSpotCheckRuns(limit = 50)` — `select * from megaplan_spot_check_runs order by started_at desc limit ?`.
- `getSpotCheckArtifact(runId)` — returns the `artifact_md` field.

All three require staff role (the page is at `/admin/...` so middleware already gates).

**Admin page** (`src/app/admin/settings/megaplan-verification/page.tsx`). Skeleton in Appendix C.9. Renders:
- Header: "Megaplan verification" + "Run now" button (calls `triggerSpotCheck`, refetches list).
- Table: timestamp, sampled SKUs, drift counts (agreed/minor/major/delayed), "View artifact" link.
- Modal: shows the rendered markdown artifact for a run.
- Sidebar: link to `docs/MEGA_PLAN_VERIFICATION_2026-04-13.md` for the one-time signed artifact.

**Reminder cron** (`src/trigger/tasks/deferred-followups-reminder.ts`). Skeleton in Appendix C.4. Daily at 09:00 ET. Reads `docs/DEFERRED_FOLLOWUPS.md`, parses YAML front-matter per entry, for each entry whose `due_date <= today` either creates or no-ops a `warehouse_review_queue` row with stable `correlation_id = 'deferred:{slug}:{due_date}'` (so the cron is idempotent — running multiple times in a day creates only one item).

**`docs/DEFERRED_FOLLOWUPS.md`**. Initial entries:

```yaml
---
- slug: phase-7-dormant-cleanup
  title: "Phase 7: dormant client-store code cleanup"
  due_date: 2026-07-13
  severity: medium
  context: "90-day dormancy review of client-store webhook + multi-store push code paths."
- slug: tier1-9-better-stack
  title: "Tier 1 #9: Better Stack synthetic monitoring"
  due_date: 2026-05-13
  severity: high
  context: "30-day waiver expiration. Required before sustained 100% rollout."
- slug: tier1-10-statuspage
  title: "Tier 1 #10: statuspage.io public status page"
  due_date: 2026-05-13
  severity: high
  context: "30-day waiver expiration. Required for client-facing incident comms."
- slug: external-sync-events-retention
  title: "external_sync_events retention cron verification"
  due_date: 2026-04-25
  severity: low
  context: "Confirm 7-day retention is firing weekly via Trigger.dev dashboard."
---
```

**Verification artifact** (`docs/MEGA_PLAN_VERIFICATION_2026-04-13.md`). Skeleton in Appendix C.16. Pre-filled Sections A (automated gate results from `pnpm release:gate`), B (Phase 4/5/6 closeout summaries copied from mega-plan §14.9), C (deferred items list copied from `DEFERRED_FOLLOWUPS.md`), D (Tier 1 status table). Section E is operator-signed Mon 17:00.

**Trigger registration + doc sync**. Edit `src/trigger/tasks/index.ts` to export the three new task constants. Update API_CATALOG.md, TRIGGER_TASK_CATALOG.md, engineering_map.yaml, journeys.yaml, TRUTH_LAYER.md (one new spot-check + reminder invariant), CLAUDE.md (Rule #73).

**Cleanup batch**. Phase 6 closeout left two items:
1. Replace `(supabase as any)` (3 occurrences) in `tests/unit/lib/billing-rates.test.ts` with the typed mock pattern used in `tests/unit/lib/inventory-fanout.test.ts`.
2. Remove the unused `beforeEach` import from `tests/unit/lib/billing-rates.test.ts`.

### §15.2. Workstream 2 — live-counting backend fix (~4 hr Sat)

**Migration 50** (planned: `20260413000050_phase4b_shipstation_fanout.sql`; **shipped as** `20260418000001_phase4b_megaplan_closeout_and_count_session.sql`). Multi-table:

```sql
-- 1) ShipStation kill switch column on workspaces
alter table workspaces
  add column shipstation_sync_paused boolean not null default false,
  add column shipstation_sync_paused_at timestamptz,
  add column shipstation_sync_paused_by uuid references users(id),
  add column shipstation_sync_paused_reason text;

-- 2) Per-SKU count session columns on warehouse_inventory_levels
alter table warehouse_inventory_levels
  add column count_status text not null default 'idle'
    check (count_status in ('idle', 'count_in_progress')),
  add column count_started_at timestamptz,
  add column count_started_by uuid references users(id),
  -- count_baseline_available: AUDIT-ONLY snapshot of `available` taken at
  -- startCountSession(). Review pass v4 corrected the formula:
  -- completeCountSession() uses CURRENT available (NOT baseline) for delta math.
  -- Baseline is recorded in the cycle_count activity row alongside current so
  -- operators can post-hoc detect "sale landed during session" cases via
  -- (sales_during_session = baseline - current_at_complete). See C.8 commentary
  -- for the Scenario A vs Scenario B trade-off rationale.
  add column count_baseline_available integer,
  -- has_per_location_data: STICKY flag preventing SKU oscillation between
  -- per-location and SKU-total ShipStation v2 fanout (R-23). Set to true on
  -- first non-zero per-location write via setVariantLocationQuantity. NEVER
  -- reset by automation. If a SKU is mistakenly switched into per-location
  -- mode, see §27.x escape valve for manual operator-gated SQL reset.
  add column has_per_location_data boolean not null default false;

-- 3) ShipStation location mirror columns on warehouse_locations
alter table warehouse_locations
  add column shipstation_inventory_location_id text,
  add column shipstation_synced_at timestamptz,
  add column shipstation_sync_error text;
create index warehouse_locations_shipstation_id_idx
  on warehouse_locations (shipstation_inventory_location_id)
  where shipstation_inventory_location_id is not null;
create index warehouse_locations_shipstation_error_idx
  on warehouse_locations (workspace_id)
  where shipstation_sync_error is not null;

-- 4) Extend InventorySource enum on warehouse_inventory_activity
alter table warehouse_inventory_activity
  drop constraint warehouse_inventory_activity_source_check;
alter table warehouse_inventory_activity
  add constraint warehouse_inventory_activity_source_check
  check (source in (
    'shopify','bandcamp','squarespace','woocommerce','shipstation',
    'manual','inbound','preorder','backfill','reconcile',
    'cycle_count','manual_inventory_count'
  ));
```

**Type extensions** (`src/lib/shared/types.ts`). Patch in Appendix C.

**Fanout extension** (`src/lib/server/inventory-fanout.ts`). Add a fourth section after the Bandcamp section, before the bundle-parent recursion:

```typescript
if (variant && guard.shouldFanout("shipstation", effectiveCorrelationId)) {
  try {
    await tasks.trigger("shipstation-v2-sync-on-sku", {
      workspaceId,
      sku,
      correlationId: effectiveCorrelationId,
      reason: "fanout_inventory_change",
    });
  } catch {
    /* non-critical — reconcile catches drift */
  }
}
```

Note the bundle-parent recursion at the bottom of `fanoutInventoryChange()` already handles the "component change → fan out parent bundle" path for Bandcamp + client_store. For ShipStation, bundles are EXCLUDED entirely (Phase 2.5 (a)), so the new section does NOT need bundle recursion.

**New Trigger task** (`src/trigger/tasks/shipstation-v2-sync-on-sku.ts`). Initial Saturday version writes a single `modify new_available: <SKU total>` per SKU to the workspace-default location. Same-day refactor (Workstream 3) makes it per-location. Skeleton in Appendix C.5. Mirrors `bandcamp-push-on-sku.ts` shape.

**Tests**:
- `tests/unit/lib/inventory-fanout.test.ts` — extends existing if present, otherwise creates. Asserts that `recordInventoryChange({ source: 'manual' })` followed by awaiting `fanoutInventoryChange()` enqueues all four targets when guard allows. Mocks `loadFanoutGuard`, `tasks.trigger`, `inventoryAdjustQuantities`.
- `tests/unit/trigger/shipstation-v2-sync-on-sku.test.ts` — distro skip, bundle skip, kill-switch skip, idempotency replay (ledger short-circuit), success path, ShipStation API failure path. Uses the same mock shape as `tests/unit/trigger/shipstation-v2-decrement.test.ts` if present.

### §15.3. Workstream 3 — locator + count session + ShipStation mirror (~11.5 hr Sat)

**ShipStation v2 client extensions** (~30 min). See Appendix C.11 for the exact additions to `src/lib/clients/shipstation-inventory-v2.ts`.

**Locations Server Actions** (`src/actions/locations.ts`, ~1.5 hr). Skeleton in Appendix C.7. Key behaviors:

- `createLocation({ name, type, barcode? })`:
  1. Insert `warehouse_locations` row (existing UNIQUE(workspace_id, name) catches duplicates → throws `LOCATION_ALREADY_EXISTS`).
  2. Try `createInventoryLocation({ inventory_warehouse_id: ws.shipstation_v2_inventory_warehouse_id, name })`.
  3. On success: `update warehouse_locations set shipstation_inventory_location_id = ?, shipstation_synced_at = now(), shipstation_sync_error = null where id = ?`.
  4. On failure: `update warehouse_locations set shipstation_sync_error = <message> where id = ?`. Returns `{ ok: true, warning: 'shipstation_mirror_failed' }`.
- `updateLocation(id, patch)`: if patch contains `name` AND row has `shipstation_inventory_location_id`, also call `updateInventoryLocation(id, { name })`.
- `deactivateLocation(id)`: blocks if any non-zero `warehouse_variant_locations.quantity` references it. Does NOT call DELETE against ShipStation.
- `retryShipstationLocationSync(locationId)`: explicit operator action for rows with `shipstation_sync_error`. Re-runs the create-and-store-id flow.
- `createLocationRange({ prefix, fromIndex, toIndex, type, padWidth?, throttleMs? })`: bulk creator with two paths (review pass v5 hardening — Vercel timeout fix):
  - **Inline path (range size ≤ 30)**: runs synchronously inside the Server Action with 300ms throttle (review pass v5 bumped from 250ms for safety margin against ShipStation's 200 req/min ceiling shared with `shipstationQueue`). 30 × 300ms = 9s + ~3s API latency = well within the Vercel 15s baseline.
  - **Trigger task path (range size > 30)**: enqueues `bulk-create-locations` Trigger task (Appendix C.17), returns a task run ID immediately, UI polls for progress. Avoids Vercel timeout for ranges that staff might create when labeling a full shelf section (e.g., A-1 through A-100). The Trigger task uses `shipstationQueue` so it's serialized against other ShipStation traffic.

Tests (`tests/unit/actions/locations.test.ts`) cover: create happy path (local + ShipStation); create with ShipStation 5xx (local succeeds, error stored, returns warning); rename-with-mirror; rename-without-existing-mirror (skips ShipStation call); deactivate-with-quantity (blocks); retry path (clears error on success); range size 30 stays inline; range size 31 routes to Trigger task and returns task run ID.

**Per-SKU count session Server Actions** (`src/actions/inventory-counts.ts`, ~1.5 hr). Skeleton in Appendix C.8. Behaviors:

- `startCountSession(sku)`: `update warehouse_inventory_levels set count_status = 'count_in_progress', count_started_at = now(), count_started_by = ? where sku = ? and count_status = 'idle' returning *`. If 0 rows updated, the SKU is already in progress — throw `ALREADY_IN_PROGRESS` with the existing session's `count_started_by` user.
- `setVariantLocationQuantity({ sku, locationId, quantity })`:
  - Read current `count_status`. If `count_in_progress`: upsert `warehouse_variant_locations` row, do NOT touch `warehouse_inventory_levels.available`, do NOT call `recordInventoryChange`. Return `{ status: 'session_partial', sumOfLocations: <new sum> }`.
  - If `idle`: upsert `warehouse_variant_locations` row, recompute SKU total, call `recordInventoryChange({ delta: newTotal - oldTotal, source: 'cycle_count', correlationId: 'loc-edit:{locationId}:{sku}:{timestamp}' })`. Return `{ status: 'fanned_out', newTotal }`.
- `completeCountSession(sku)`:
  1. Read `count_status` (must be `count_in_progress`, else throw).
  2. Sum `warehouse_variant_locations.quantity` for this SKU.
  3. Read current `warehouse_inventory_levels.available`.
  4. `delta = sumOfLocations - currentAvailable`.
  5. Call `recordInventoryChange({ workspaceId, sku, delta, source: 'cycle_count', correlationId: 'count-session:{startedAt}:{sku}' })`. This handles Redis + Postgres + fanout.
  6. `update warehouse_inventory_levels set count_status = 'idle', count_started_at = null, count_started_by = null where sku = ?`.
  7. Return `{ newTotal, delta, fanoutEnqueued: true }`.
- `cancelCountSession(sku, { rollbackLocationEntries })`:
  - If `rollbackLocationEntries`: delete `warehouse_variant_locations` rows where `sku = ? and updated_at >= count_started_at`. (Caveat: this also deletes any unrelated location writes from other paths during the session window; in practice, only the count-session UI writes per-location during in-progress, so this is correct for our usage.)
  - `update warehouse_inventory_levels set count_status = 'idle', count_started_at = null, count_started_by = null where sku = ?`.
- `getCountSessionState(sku)`: returns `{ status, startedAt, startedBy: { id, name }, sumOfLocations, currentAvailable }` for the UI.

Tests (`tests/unit/actions/inventory-counts.test.ts`) cover the fanout-suppression invariant: a `setVariantLocationQuantity` call during `count_in_progress` MUST NOT trigger the fanout mock. A subsequent `completeCountSession` MUST trigger the fanout mock exactly once.

**Locations admin page** (`src/app/admin/settings/locations/page.tsx`, ~2 hr). Skeleton in Appendix C.10.

**Inventory page expanded-row count UI** (`src/app/admin/inventory/page.tsx`, ~2.5 hr). Patches the existing expanded detail at lines 346–419 (see Appendix B.8 for the current shape). Adds a "Count session" panel above the existing Locations list. UI states:

- `count_status === 'idle'`: shows "Start count" button.
- `count_status === 'count_in_progress'`: shows status badge with started-by + duration; running sum-of-locations chip; per-location editable list (each row has inline-editable quantity); "+ Add location" affordance (typeahead search across `listLocations()` results AND a "Create new location" option that calls `createLocation()` inline); "Complete count" primary button; "Cancel count" with confirm dialog. While in-progress, the parent row's Avail cell becomes read-only with a "(count in progress — sum so far: 47)" hint.

**§15.3 GATE — Saturday afternoon per-location semantics probe (REQUIRED before per-location rewrite ships, ~30 min)**. This is a hard gate elevated from A-6 per the 2026-04-19 review pass. Before deploying the per-location rewrite of `shipstation-v2-sync-on-sku`, the agent MUST run a manual probe in dev that proves three behaviors:

1. **Sum semantic**: write `modify new_available: 5` to ShipStation Location-A and `modify new_available: 3` to Location-B for one test SKU. Then GET `/v2/inventory?skus=<sku>`. Expected: response shows two separate location records and a SKU-level `available: 8` aggregate. *If response shows `available: 3` (last-write-wins) or `available: 5` (first-write-wins), A-6 is FALSE → DO NOT deploy per-location rewrite. Fall back to single-location-total writes for the weekend; per-location ships next week.*
2. **Zero-at-location semantic** (OQ-2): with the SKU above, attempt `modify new_available: 0` on Location-A. Expected: 400 rejection (matches Patch D2). Then attempt `adjust quantity: 0` on Location-A (which IS now seeded). Expected: 200 OK; aggregate drops to 3.
3. **Unseeded zero behavior** (R-20): create a brand-new Location-C in ShipStation (no SKU has ever had inventory there). Attempt `adjust quantity: 0` on Location-C for our test SKU. Expected: 400/404 ("no row to adjust"). This validates the C.5 try-catch skip path for new locations counted at 0.

Probe outcomes are recorded in `MEGA_PLAN_VERIFICATION_2026-04-13.md` Section A appendix. If outcome 1 is false, the agent halts WS3 step 6 and notifies the operator; outcomes 2-3 confirm the C.5 hardening branches are correct.

**Per-location rewrite of `shipstation-v2-sync-on-sku`** (~1.5 hr, gated by the probe above). New behavior described in §12 FR-8. Skeleton in Appendix C.5. Each per-location write gets its own `external_sync_events` row keyed `(workspace_id, sku, location_id, correlationId)`; the `correlation_id` field stores `correlationId + ':loc:' + locationId` to keep the unique constraint stable across multiple per-location writes from one fanout event.

**Tests** (~1 hr beyond per-action tests):
- Integration: count session interleaved with sale (start session → enter 3 location entries summing to 80 → simulate `recordInventoryChange({ delta: -5, source: 'bandcamp' })` → confirm SKU total = 95, location entries unchanged → complete session → confirm final total = 80 not 75, because complete session uses post-sale-current-available as the base for delta).
- UI smoke: typeahead "Create new location" path successfully creates and selects.
- Per-location push: 3 locations all mirrored → 3 v2 writes; 1 location unmirrored → 2 writes + 1 skip + warning logged; SKU with no per-location entries → falls back to single workspace-default write.

### §15.4. Saturday late-evening release gate (~30 min)

`pnpm release:gate` end-to-end → `supabase db push --yes` → Vercel production deploy → first manual `triggerSpotCheck()`. Bridge stays at 0%. Verify: migrations 40 and 50 applied (`supabase migration list --linked`); Locations admin page loads; Inventory expanded-row shows count session panel.

### §15.5. Sunday early-morning UX polish (~2.25 hr)

Detailed in §28. All edits to `src/app/admin/inventory/page.tsx` plus `getTodayCountProgress()` in `src/actions/inventory.ts`. Patch shapes in Appendix C.13 and C.14.

### §15.6. Documented fallback priority if Saturday slips

**Pre-flight gate (v6 hardening — must pass before ANY Saturday work begins):** On a fresh feature branch, paste C.6 + C.7 + C.8 verbatim from this plan and run `pnpm typecheck`. Expected: clean. If it errors, the v6 codebase verification missed a divergence — pause and add a v7 entry to §17.1 + §23 before touching any other workstream. This is a 5-minute check that catches bad imports, missing helpers, or schema drift before they cascade through 22 hours of Saturday work.

In priority order:

1. Workstream 1 (closeout). Must ship Sat for verification + reminder cron.
2. Workstream 2 (basic ShipStation v2 fanout for SKU totals). Must ship Sat for the Sun ramp to work at all.
3. Workstream 3 sub-tasks (ranked):
   - 3a. ShipStation client extensions (createInventoryLocation, updateInventoryLocation, listInventoryLocations).
   - 3b. Count session backend Server Actions (start/setLocationQty/complete/cancel) — **includes baseline snapshot for R-19**.
   - 3c. Inventory page expanded-row count UI with inline create.
   - 3d. Locations Server Actions with ShipStation mirror — **includes C.7 409 resolution and range throttle**.
   - 3e. **§15.3 GATE — per-location semantics probe**. If probe outcome 1 (sum semantic) fails, 3f is dropped; per-location ships next week and SKU-totals from WS2 cover Tuesday.
   - 3f. Per-location rewrite of `shipstation-v2-sync-on-sku` — **only ships if 3e passes outcome 1**.
   - 3g. Standalone Locations admin page (lowest priority — defers to next week if needed since inline create from count session UI covers Tue/Wed staff workflow).

Whatever fraction of Workstream 3 is incomplete is documented in Section E of the verification artifact and converted to a deferred item via `DEFERRED_FOLLOWUPS.md`. **The probe gate (3e) is the only gate that can block 3f without blocking the rest of WS3 — all other sub-tasks are independently shippable.**

## §16. Assumptions

Numbered list. Each is testable.

- **A-1.** Today (2026-04-13) `fanout_rollout_percent = 0` for all workspaces. *Test:* `select id, fanout_rollout_percent from workspaces;`.
- **A-2.** ShipStation v2 `POST /v2/inventory_locations` accepts `{ inventory_warehouse_id, name }` and returns `{ inventory_location_id, name, ... }`. *Test:* manual `curl` against the v2 API in dev.
- **A-3.** ShipStation v2 `PUT /v2/inventory_locations/{id}` accepts `{ name }` for renames. *Test:* manual `curl`.
- **A-4.** ShipStation v2 `DELETE /v2/inventory_locations/{id}` is idempotent (re-deleting a deleted ID returns 404 not 500). *Test:* manual `curl`. (Even if it 500s, we don't auto-call it this weekend.)
- **A-5.** ShipStation v2 `POST /v2/inventory` with `transaction_type: 'modify' new_available: 0` returns 400 (Patch D2 probe outcome). *Test:* `tests/unit/clients/shipstation-inventory-v2.test.ts` and live probe in dev.
- **A-6.** **PROBE REQUIRED — gates §15.3 per-location rewrite deploy (review pass 2026-04-19).** Per-location `modify new_available: N` writes do NOT cause ShipStation to recompute the SKU's total `available` field as the sum of per-location values automatically — ShipStation manages this on its side because each location is a separate inventory record. *Risk if false:* per-location writes overwrite each other and the SKU shows the last-written-location's quantity instead of the sum, breaking the entire per-location strategy. *Test:* the §15.3 GATE probe runs three explicit cases against a dev test SKU (sum semantic, zero-at-location, unseeded-zero); outcomes recorded in MEGA_PLAN_VERIFICATION_2026-04-13.md Section A appendix. *Fallback if probe fails outcome 1:* keep `shipstation-v2-sync-on-sku` writing single SKU-totals to the workspace-default location (the C.5 fallback branch); per-location locator data still works in our app for staff picking; per-location ShipStation writes ship next week pending an alternate v2 endpoint or workaround.
- **A-7.** `warehouse_locations.workspace_id` is set on every existing row (not nullable in practice). *Test:* `select count(*) from warehouse_locations where workspace_id is null;` should return 0.
- **A-8.** `warehouse_variant_locations` table exists with columns `(variant_id, location_id, quantity, updated_at)`. *Test:* `\d warehouse_variant_locations`.
- **A-9.** `warehouse_inventory_levels` is keyed by `(workspace_id, variant_id)` (or has a unique constraint thereon) so the existing `record_inventory_change_txn` RPC works on a single matching row. *Test:* known true from Phase 5 reconcile work.
- **A-10.** The `derive_inventory_org_id` trigger continues to fire on UPDATE as well as INSERT. *Test:* `select tgname, tgenabled from pg_trigger where tgrelid = 'warehouse_inventory_levels'::regclass;`.
- **A-11.** Adding three columns to `warehouse_inventory_levels` does not break the Phase 5 `sku_sync_status` view. *Test:* re-run `pnpm test` after migration 50 (shipped as `20260418000001_phase4b_megaplan_closeout_and_count_session.sql`).
- **A-12.** `pnpm release:gate` script exists and includes typecheck + test + build + biome + the inventory write-path lint guard. *Test:* `cat package.json | grep release:gate`.
- **A-13.** Trigger.dev v4 `tasks.trigger()` is the supported way to enqueue from a Server Action (not `runs.trigger()` or `tasks.batchTrigger()`). *Test:* known true from existing fanout code (Appendix B.1).
- **A-14.** Operator has the ShipStation v2 API key configured in production (`SHIPSTATION_V2_API_KEY`). *Test:* `vercel env ls`. Without this key, every ShipStation call fails — but the system fails gracefully (per-integration kill switch + fanout guard catch the 5xx burst).
- **A-15.** `inventory_warehouse_id` for the Clandestine workspace is configured (`workspaces.shipstation_v2_inventory_warehouse_id`) — needed by `createInventoryLocation`. *Test:* `select id, shipstation_v2_inventory_warehouse_id from workspaces;`. Set by Phase 3 admin if not.
- **A-16.** The current behavior of `bandcamp-push-on-sku` (push the new `available - safety` value as absolute) is preserved by the new ShipStation per-SKU push path. *Test:* tests in `tests/unit/trigger/bandcamp-push-on-sku.test.ts` continue to pass; ShipStation tests assert the same shape of math.
- **A-17.** Operator UX dry runs Sun 10:00 and Mon 14:00 are calendared. *Test:* operator confirms in the chat reply that signs off on this plan.
- **A-18.** Staff training on Tuesday Apr 21 09:00 is non-rescheduleable. *Test:* operator-stated; no system test.
- **A-19.** `pnpm`, `supabase`, and `git` commands are auto-allowed in the operator's Cursor session (`.cursor/permissions.json` configured per user-agent-defaults). *Test:* run `supabase db push --yes` without prompting.
- **A-20.** The `useAppQuery` and `useAppMutation` hooks in `src/lib/hooks/use-app-query.ts` exist with the signatures used in the new Inventory page additions. *Test:* known true from existing usage in the page (Appendix B.8 line 29).
- **A-21.** `sonner` is installed for toast feedback (or there is an existing toast utility). *Test:* `grep sonner package.json`. If absent, fall back to inline status banners.
- **A-22.** (v4 review) Once a SKU has per-location data, ShipStation v2 holds the per-location records in a way that survives subsequent per-location writes for OTHER SKUs at the same location. I.e., `has_per_location_data = true` is a permanent state because ShipStation also remembers. *Test:* §15.3 GATE outcome 1 confirms this. *Risk if false:* the sticky flag still prevents oscillation but spot-check would surface drift if ShipStation drops per-location records for inactive SKUs.
- **A-23.** (v4 review) `recordInventoryChange()` does NOT decrement `warehouse_variant_locations.quantity` for sales (only `warehouse_inventory_levels.available`). Per-bin sale routing is a future hardening. *Test:* known true from existing record-inventory-change.ts (Appendix B.2). *Implication:* count session math uses current available (post-sale) as the baseline; staff must count physical bin contents after-the-fact in normal operations.
- **A-24.** (v4 review) `fanout-guard.ts isInRolloutBucket(correlationId, percent)` uses correlation-id hash, not SKU hash. Per-SKU consistency at intermediate rollout percentages is best-effort. *Test:* `grep "isInRolloutBucket\|hashCorrelationId" src/lib/server/fanout-guard.ts`. *Mitigation:* tracked as R-24, deferred follow-up; ramp from 0→100 directly is an option to skip this concern.

Appendix A reorganizes these by category for the reviewer.

## §17. Risks

Full table; abbreviated top-five appears in §6.

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Count session fanout suppression bug → silent oversell | Low | Critical | UX dry run #1 Part B explicitly canaries; unit test asserts no fanout mock call during `count_in_progress`; spot-check artifact distinguishes count-in-progress SKUs from idle drift |
| R-2 | Saturday ~22 hr build slips, locator UI doesn't ship | Medium | Medium | §15.6 fallback priority; count session backend + Avail cell still works for single-bin SKUs Tue/Wed |
| R-3 | ShipStation v2 5xx burst during 100% ramp + count storm | Medium | High | `shipstationQueue concurrencyLimit: 1`; sensor halts at 2% 5xx in 30 min; `shipstation_sync_paused` kill switch as escape hatch |
| R-4 | ShipStation location mirror failure leaves SKUs unsynced | Medium | Medium | Local row keeps working; per-location writes skip null IDs; daily reconcile retry; explicit operator retry button |
| R-5 | UX dry run #2 reveals staff pace too slow (>90s/SKU) | Medium | Medium | 3 hr triage window before signoff; fall back to Avail-cell for single-bin SKUs; multi-bin counts continue across the week |
| R-6 | Toast feedback creates false confidence (toast says "pushing…" before API lands) | Low | Low | Toast intentionally about queueing not settling; spot-check artifact catches actual drift hourly |
| R-7 | Abandoned count session blocks fanout indefinitely for that SKU | Low | Medium | 24-hr stale-session sensor creates review queue item; operator can force-cancel from inventory page |
| R-8 | Duplicate location creation by two staff on different ends of warehouse | Low | Low | `UNIQUE(workspace_id, name)` already enforced; typeahead surfaces existing match before "Create new" |
| R-9 | ShipStation v2 per-location math mismatches A-6 assumption | Low | High | Saturday eve dry-run; if wrong, fall back to single-location mode for weekend |
| R-10 | A new Server Action exceeds 30s on slow Supavisor connection | Low | Low | Profile during Sat dev; `completeCountSession` is the longest path and is bounded |
| R-11 | Wave 1 frozen primitive (`types.ts`) needs broader refactor than additive | Low | Medium | Per Rule #38: pause + hotfix-from-main + rebase, never modify in worktree. This plan only adds (NFR-8). |
| R-12 | `useAppQuery` cache invalidation misses the new count session state, UI shows stale | Low | Low | Cache key includes SKU; explicit `queryClient.invalidateQueries` after each session-mutating action |
| R-13 | `pnpm release:gate` Saturday night exceeds the agent's tolerance window | Low | Low | Operator can manually run gate components in parallel if needed |
| R-14 | Tier 1 #9 / #10 30-day waiver expires without operator action | Medium | Medium | Reminder cron creates review queue item on 2026-05-13; operator can extend or close at that point |
| R-15 | Phase 7 dormant code path turns out to be load-bearing during the week | Low | Medium | 90-day deferral provides ample time to detect; immediate revert is `git checkout` since nothing is deleted yet |
| R-16 | Bandcamp OAuth token gets destroyed during weekend due to a queue miscoordination | Very low | High | Rule #9 enforces shared `bandcamp-api` queue; no new code path violates this |
| R-17 | The `external_sync_events` ledger 7-day retention sweeper hasn't run, table grows unbounded | Low | Low | Tracked in `DEFERRED_FOLLOWUPS.md` with due date 2026-04-25 |
| R-18 | A staff member cancels a session with rollback and loses real per-location data | Low | Low | Confirm dialog explicit: "Keep entries as draft" or "Discard". Default is "Keep". |
| R-19 | In-flight sale during count session: count formula is fundamentally ambiguous when sales happen mid-session. C.8 picks `delta = sumOfLocations - current_available` (Scenario A correct, Scenario B has 1-unit overcount until next reconcile). | Medium | Low | Operator guidance §27.3: "Run count sessions during low-shipping windows; complete sessions within 30 min." Audit: every cycle_count activity row records both baseline and current; `sales_during_session > 0` flag enables post-hoc analysis. Detection: spot-check sees count > pre-session-available + sales, classifies as drift_minor for next-cycle review. Future hardening: per-bin sale routing (Q3 follow-up). |
| R-20 | Brand-new ShipStation location's first per-location write is `quantity: 0` (staff counted an empty bin). `adjust quantity: 0` rejects with 400/404 because no row exists to adjust. Without handling, the per-location write fails and gets stuck. | High | Low | C.5 hardening: catch 400/404 on zero-write, mark ledger as `ok_noop`, skip. Reconcile sensor catches drift if any. The next non-zero count to that location seeds the row via `modify new_available: N >= 1`. |
| R-21 | `createLocationRange` failure modes: (a) inline path hits v2's 200 req/min ceiling on large ranges, (b) inline path exceeds Vercel Server Action timeout (~15s baseline) for ranges >50, (c) range-create traffic competes with `shipstationQueue` fanout traffic in the same v2 rate bucket. | Medium | Medium | C.7 v5 hardening (review pass v5): inline path capped at 30 entries with 300ms throttle (~9s sleep + ~3s API ≈ 12s total, safe). Ranges >30 route to `bulk-create-locations` Trigger task (Appendix C.17), serialized through `shipstationQueue` (no rate competition), no Vercel timeout ceiling. UI shows task run ID for tracking. |
| R-22 | `createLocation` race: two staff create "A-12-3" simultaneously. Local UNIQUE catches one, but ShipStation might have a stale "A-12-3" from old data and 409 the survivor. | Low | Low | C.7 hardening per OQ-1: catch 409, look up existing ShipStation location by name, store its ID locally with `warning: 'shipstation_mirror_resolved_existing'`. Idempotent against pre-existing stale ShipStation locations. |
| R-23 | SKU oscillates between per-location and SKU-total fanout paths. Example: SKU has bins A+B+C with mapped ShipStation IDs. A staff member deletes all three bin rows mid-session. Next fanout sees zero per-location data, falls back to a single workspace-default SKU-total write, overwriting the per-location records in ShipStation. | Medium | High | C.2 + C.5 + C.8 hardening: sticky `warehouse_inventory_levels.has_per_location_data` boolean. Set to true on first non-zero per-location write (C.8 setVariantLocationQuantity), never reset. C.5 task checks the flag — if true but no mapped rows currently exist, skip the write and surface `skipped_per_location_history_no_mapped`; reconcile sensor handles drift. Prevents silent overwrite. |
| R-24 | `fanout_rollout_percent` is correlation-id-deterministic, not SKU-deterministic. The same SKU may be in/out of fanout across consecutive events depending on which webhook fires (e.g., webhook with corr-id "abc" hashes to bucket 5, webhook with corr-id "xyz" hashes to bucket 75). Causes apparent inconsistency at 10/50% rollout. | Medium | Medium | Documented as a known limitation for v3. The 22-hour Saturday window does not have time to refactor `fanout-guard.ts` (frozen primitive — would require Rule #38 hotfix-from-main). Mitigation for ramp: skip 10/50% intermediate stages OR treat percentage as "approximate" knowing per-SKU consistency is best-effort. Spot-check catches any SKU consistently missed. Tracked in DEFERRED_FOLLOWUPS as `fanout-guard-sku-deterministic` due 2026-05-13. |

## §17.1. Hardenings adopted from review passes

Two structured review passes (2026-04-19 v3 and 2026-04-19 v4) added the following hardenings. Each maps to a specific risk row above and a specific code/skeleton location in Appendix C.

### §17.1.a. v3 hardenings (sequencing + ShipStation API edge cases)

| Hardening | Location | Addresses | Test |
|---|---|---|---|
| Saturday afternoon §15.3 GATE: 3-case ShipStation v2 per-location semantics probe | §15.3, A-6 | A-6, OQ-2, R-9, R-20 | Probe results recorded in MEGA_PLAN_VERIFICATION Section A appendix |
| Count session `count_baseline_available` column added (audit-only — see v4 correction below) | C.2, C.8 | R-19 (audit) | `tests/unit/actions/inventory-counts.test.ts` |
| C.5 unseeded-location zero-write skip path | C.5 | R-20 | `tests/unit/trigger/shipstation-v2-sync-on-sku.test.ts`: mock 400 on adjust-zero, assert ledger `ok_noop` |
| C.7 createLocation 409/duplicate resolution to existing ShipStation ID | C.7 | OQ-1, R-22 | `tests/unit/actions/locations.test.ts`: mock 409 + list response, assert ID stored |
| C.7 createLocationRange 250ms throttle between calls | C.7 | R-21 | `tests/unit/actions/locations.test.ts`: assert sleep called between iterations |
| Operator guidance §27.3: "count during low-shipping windows" | §27.3, R-19 | R-19 (process control) | Operator dry-run #2 Mon 14:00 includes a sale-during-session scenario |
| A-6 elevated to PROBE REQUIRED gate | §16 | A-6 | If probe outcome 1 fails, agent halts WS3 step 6 and notifies operator |

### §17.1.c. v5 hardenings (Vercel timeouts + DDL gap + atrophy script)

| Hardening | Location | Addresses | Test |
|---|---|---|---|
| §15.2 migration DDL listing now includes `has_per_location_data` (gap caught by reviewer 2 — only Appendix C.2 had it) + comment block updated to v4 audit-only semantics | §15.2 | Doc-code consistency | Schema diff after `supabase db push` matches both §15.2 and C.2 |
| `createLocationRange` inline-vs-Trigger split at 30 entries | §15.3, C.7 | R-21, Vercel Server Action timeout (reviewer 1 §3) | `tests/unit/actions/locations.test.ts`: range size 30 stays inline; range size 31 returns `mode: "trigger"` with task run ID |
| Throttle bumped 250ms→300ms for safety margin against shared rate bucket | C.7, C.17 | R-21, reviewer 2 §2 | Test asserts default throttle == 300 |
| New `bulk-create-locations` Trigger task using `shipstationQueue` | C.17 | R-21 (large ranges) | `tests/unit/trigger/bulk-create-locations.test.ts`: 50-entry range processes serially; ShipStation kill switch mid-run skips remaining mirrors but inserts local rows |
| `has_per_location_data` manual-reset escape valve documented in §27 runbook | §27 escape valve | Reviewer 2 §1 (sticky flag never resets automatically) | Operator can run documented SQL to reset for a SKU after audit |
| Stale ShipStation v2 location cleanup script tracked as deferred Thursday operator task | §22 deferred items | Reviewer 1 §1 (UI pollution from atrophied locations) | Script runs read-only by default with `--apply` flag for actual deletion |

### §17.1.b. v4 hardenings (state machine correctness + ramp resilience)

| Hardening | Location | Addresses | Test |
|---|---|---|---|
| **Count session formula corrected to `current - sumOfLocations` (NOT baseline)** — v3 picked baseline which was wrong for Scenario A. Baseline column retained for audit metadata only. | C.8 | R-19 (correctness) | `tests/unit/actions/inventory-counts.test.ts`: assert post-sale-counted scenario produces delta=0 (no double-decrement) |
| Sticky `warehouse_inventory_levels.has_per_location_data` flag prevents SKU oscillation between per-location and SKU-total fanout | C.2, C.5, C.8 | R-23 | `tests/unit/trigger/shipstation-v2-sync-on-sku.test.ts`: assert `skipped_per_location_history_no_mapped` when flag=true and no mapped rows |
| `updateLocation` reordered: ShipStation rename FIRST, local update only on success | C.7 | §4.1 review concern | `tests/unit/actions/locations.test.ts`: assert local row unchanged when ShipStation rename throws |
| Spot-check excludes `count_in_progress` SKUs from sample | C.3 | R-1 (false positives), §5.2 | RPC test `megaplan_sample_skus_per_client` with mock data |
| Spot-check ramp-window sample: 15 SKUs (vs 5 daily), prioritized by recent activity | C.3 | §5.1 | Test asserts per_client=15 when any workspace.fanout_rollout_percent < 100 |
| Spot-check persistence rule: drift_major must repeat in 2 consecutive runs before review queue item | C.3 | §5.3 (queue noise) | Test asserts no review item on first occurrence; review item on persisted occurrence |
| R-24 deferred follow-up registered: SKU-deterministic fanout_rollout_percent (currently event-deterministic) | DEFERRED_FOLLOWUPS, R-24 | R-24 | Tracked for 2026-05-13 hotfix-from-main per Rule #38 |

Hardening DOES NOT include: per-bin sale routing (deferred — requires reconciler pass on `warehouse_orders` and per-line shipment-to-location mapping), ShipStation queue for inline location creates (rejected — operator UX needs immediate result), bidirectional location sync (rejected per §20), automatic stale ShipStation location deletion (rejected per §20), refactor of `fanout-guard.ts` to be SKU-deterministic (deferred per R-24 — would require Rule #38 hotfix-from-main, doesn't fit Saturday window).

### §17.1.d. v6 hardenings (codebase verification pass — pre-build sanity check)

A full triple-check of every file the plan touches was run before kicking off the Saturday build. The pass mapped each plan claim onto live code in `src/` and `supabase/migrations/` and surfaced the following plan-vs-codebase mismatches. All have been corrected in this revision so build agents can paste C.* skeletons directly without mental rewrites.

| Hardening | Location | Addresses | Test / verify |
|---|---|---|---|
| **Global rename `createServerActionClient` → `createServerSupabaseClient`** in all C.* skeletons (15 occurrences) + NFR-6 | C.6, C.7, C.8, C.9, C.13, NFR-6 | Compile-blocking — `createServerActionClient` does not exist in `src/lib/server/supabase-server.ts`. Actual export is async `createServerSupabaseClient()`. All call sites now `await` it. | `pnpm typecheck` after C.6/C.7/C.8 land — clean |
| **`requireStaff()` destructuring corrected** to `{ userId, workspaceId }` (was `{ user, workspaceId }`) and `user.id` → `userId` everywhere | C.6, C.7, C.8 | Compile-blocking — actual `requireStaff()` in `src/lib/server/auth-context.ts` returns `{ userId: string; workspaceId: string }`, not a `user` object. | `pnpm typecheck` clean; `userId` is the `users.id` UUID compatible with `count_started_by uuid REFERENCES users(id)` |
| **B.9.6 `adjustInventory` excerpt replaced** with verbatim source from `src/actions/inventory.ts` (was a fabricated `getStaffContext()` shape) | B.9.6 | Documentation accuracy — the existing action inlines auth (`supabase.auth.getUser()` + workspace lookup) rather than calling `requireStaff()`. Plan now reflects reality. | Diff B.9.6 against `src/actions/inventory.ts` lines 313–345 |
| **`megaplan_sample_skus_per_client` RPC SQL added** to C.3 + recommendation to renumber spot-check migration `40` → `60` so it sequences after Migration 50 | C.3, C.1 | Functional gap — the RPC was referenced but never defined; without it `megaplan-spot-check` task throws `function does not exist`. Renumbering ensures `count_status` column exists when the function references it via `coalesce(count_status, 'idle')`. | `supabase db push` succeeds; `select * from megaplan_sample_skus_per_client(5);` returns rows |
| **`shipstation_v2` already in `ExternalSyncSystem` union** — plan's earlier "extend the type" guidance was a no-op | NFR-2, B.4 | Doc accuracy — verified `src/lib/server/external-sync-events.ts` already has `\| "shipstation_v2"`. Build agent should skip the type-extension step. | Grep `external-sync-events.ts` for the literal `"shipstation_v2"` |
| **`workspaces.shipstation_sync_paused` already exists** (`20260413000010_tier1_hardening.sql`) — Migration 50 step 1 must be idempotent | §15.2 | Migration safety — `add column if not exists` already used; no double-create risk. Build agent must NOT re-define the column under a different name. | `supabase db push` succeeds twice (idempotent) |
| **`fanout-guard.ts PAUSE_COLUMN` already maps `"shipstation"` → `shipstation_sync_paused`** — no `shipstation_v2` key needed | C.12, fanout-guard | Doc accuracy — single ShipStation kill switch covers both v1 and v2. Build agent uses `guard.shouldFanout("shipstation", correlationId)` for the new fanout target, NOT `"shipstation_v2"`. | Read `src/lib/server/fanout-guard.ts` `PAUSE_COLUMN` literal map |
| **Existing fanout uses positional `(workspaceId, sku, newQuantity, delta?, correlationId?)` signature** — plan's C.12 patch must match | C.12 | Compile-blocking — confirmed; the C.12 insert sits inside the existing `fanoutInventoryChange` function body which already has `workspaceId`, `sku`, `correlationId` in scope. No signature change needed. | `pnpm typecheck` after C.12 patch lands |
| **`listInventoryLocations(warehouseId: string)` is positional, not options object** | C.7 (`createLocation` 409 fallback) | Compile-blocking — verified actual signature; plan's `listInventoryLocations(warehouseId)` call is correct. Returns `Promise<V2InventoryLocation[]>` with `{ inventory_location_id, inventory_warehouse_id, name }`. | C.7 implementation builds against the actual return shape |
| **`adjustInventoryV2` returns `Promise<unknown>`** — C.5 must not assume a typed response shape | C.5 | Defensive coding — `markExternalSyncSuccess(supabase, claim.id, response)` accepts `unknown`, so passing the raw response is safe. Do not destructure fields off it. | C.5 builds; existing `shipstation-v2-decrement.ts` follows the same pattern |
| **Pre-existing migration ordering bug flagged in operator notes** (does NOT block plan) — `20260417000001` creates `external_sync_events` AFTER `20260413000010` indexes it and `20260413000030` views it | §27 operator notes (new) | From-scratch resets fail — but operator's live DB has applied them in actual write order, so unaffected. Flag for future reset script. | Operator-only — `supabase db reset` would fail today; live DB is intact |
| **`src/lib/shared/utils.ts` does not exist; codebase uses `src/lib/utils.ts`** — Rule #57 reference is aspirational | §22 deferred items | Doc-code drift — flagged as deferred follow-up to either create the shared/utils.ts file (per Rule #57) or update Rule #57 to point at the actual location. Not a blocker for the Saturday build. | Tracked in DEFERRED_FOLLOWUPS for next housekeeping pass |
| **`ROLE_MATRIX` does not exist; codebase uses `STAFF_ROLES`** — Rule #40 reference is aspirational | §22 deferred items | Doc-code drift — STAFF_ROLES already used by `requireStaff()` and middleware. Rule #40 wording should be updated, but builds work today. | Tracked in DEFERRED_FOLLOWUPS |
| **`/admin/inventory/page.tsx` expanded-row uses `colSpan={8}` against a 10-column table** — pre-existing visual quirk | §15.4 | Pre-existing UI quirk — plan's C.13 patch preserves the existing colSpan to avoid scope creep. | Visual sanity check during Saturday Workstream 3 |
| **`scanning.ts` does NOT call `requireStaff()`** (relies on middleware) — pre-existing gap, plan deprecates the path | §22 deferred items | Pre-existing — plan removes scanning.ts as a primary write path on Tuesday so the gap is moot for Tuesday onboarding. | DEFERRED_FOLLOWUPS entry: "Audit scanning.ts auth before re-enabling /admin/scan" |

**Summary of v6 outcomes:**
- 5 compile-blocking renames fixed (createServerActionClient → createServerSupabaseClient, user.id → userId, requireStaff destructuring).
- 1 functional gap fixed (megaplan_sample_skus_per_client RPC SQL added; migration sequence corrected).
- 4 doc-accuracy fixes (B.9.6 excerpt now real, ExternalSyncSystem already had shipstation_v2, workspaces.shipstation_sync_paused already exists, fanout-guard PAUSE_COLUMN already maps shipstation).
- 4 pre-existing concerns flagged as deferred (not plan blockers).
- Net result: every C.* skeleton in this plan is now consistent with the live `src/` and `supabase/migrations/` state. A build agent can `Read` a skeleton and paste it without renaming.

**Build-day dry-run gate (recommended):** Before starting Saturday Workstream 3, run `pnpm typecheck` on a feature branch with C.6 + C.7 + C.8 pasted as-is. If it returns clean, the v6 verification held and the rest of the plan can proceed. If it errors, the v6 hardening missed a divergence — pause and add a v7 entry before continuing.

## §18. Validation plan

Pre-deploy gates (must pass before `supabase db push`):

- `pnpm typecheck` — clean.
- `pnpm test` — all unit tests pass.
- `pnpm check` — Biome clean.
- `pnpm build` — Next.js build succeeds.
- `pnpm release:gate` — composite gate.

Post-deploy validation (Sat ~22:00):

- `supabase migration list --linked` — migrations 40 + 50 applied.
- Vercel deployment succeeds without runtime errors in Sentry's first 5 minutes.
- `/admin/settings/locations/page.tsx` loads without 500.
- `/admin/inventory` expands a row and shows the new count session panel.
- `/admin/settings/megaplan-verification` loads.
- First manual `triggerSpotCheck()` returns a row in `megaplan_spot_check_runs` with `drift_major_count = 0`.
- First manual location create from the admin page succeeds AND populates `shipstation_inventory_location_id`.

Per-ramp validation (Sun 10:00, 12:00, 14:00, 16:00, 18:00; Mon 09:00, 14:00, 17:00):

- UX dry run results recorded in operator chat.
- Spot-check after each ramp returns zero `drift_major`.
- Reconcile sensor health (Phase 5 page) green.
- Sentry error rate within baseline.
- ShipStation v2 5xx rate < 2% over the past 30 min.

Mon 17:00 signoff gate:

- All ramps green.
- `docs/MEGA_PLAN_VERIFICATION_2026-04-13.md` Section E filled with timestamps, run IDs, dry run results, and operator signature.
- Mega-plan moved to `docs/archive/`.
- Reminder cron enabled in Trigger dashboard.
- Doc-sync items from §8 verified (TRUTH_LAYER, API_CATALOG, TRIGGER_TASK_CATALOG, engineering_map, journeys, CLAUDE).

## §19. Rollback plan

Three layers, increasing severity:

### §19.1. Per-integration kill switch (preferred)

`UPDATE workspaces SET shipstation_sync_paused = true, shipstation_sync_paused_at = now(), shipstation_sync_paused_reason = 'rollback: <reason>' WHERE id = '<id>';`

Effect: `fanoutInventoryChange()` skips the ShipStation v2 enqueue. `shipstation-v2-adjust-on-sku` (shipped task name; planned as `shipstation-v2-sync-on-sku`) already-enqueued tasks check `shipstation_sync_paused` at task entry and short-circuit. As of audit fix F3 (2026-04-13), `shipstation-v2-adjust-on-sku` ALSO honors the global `inventory_sync_paused` flag at task entry (`skipped_inventory_sync_paused` status). Bandcamp + Shopify fanout continue.

For Bandcamp issues: `UPDATE workspaces SET bandcamp_sync_paused = true …`. For Shopify: `clandestine_shopify_sync_paused`.

### §19.2. Global pause (escape hatch)

`UPDATE workspaces SET inventory_sync_paused = true, inventory_sync_paused_at = now(), inventory_sync_paused_reason = 'rollback: <reason>' WHERE id = '<id>';`

Effect: `fanoutInventoryChange()` skips ALL fanout. Redis + Postgres still update. Reconcile tiers still run (read-only). Use this if multiple integrations are misbehaving simultaneously.

### §19.3. Ramp reversal

`UPDATE workspaces SET fanout_rollout_percent = 0 WHERE id = '<id>';`

Effect: 0% of correlation IDs hit fanout. Doesn't disable the integrations themselves. Use this if the issue is "too much load too fast" rather than "this integration is broken".

### §19.4. Code revert (last resort)

If a deployed change is structurally broken:

1. `git revert <commit>` for the offending change.
2. `pnpm release:gate` on the revert.
3. Vercel redeploy.
4. Migration 50 is intentionally additive; if migration 40 or 50 itself is the problem, drop the new columns/table manually (DDL in Appendix D for reference).

### §19.5. Count session emergency reset

If a SKU is stuck in `count_status = 'count_in_progress'` and the operator can't reach the UI:

```sql
UPDATE warehouse_inventory_levels
SET count_status = 'idle', count_started_at = null, count_started_by = null
WHERE sku = ?;
```

This does NOT discard the per-location entries (those stay in `warehouse_variant_locations` until the next session or manual cleanup). It re-enables fanout for the SKU.

### §19.6. `has_per_location_data` manual reset (review pass v5)

The sticky `has_per_location_data` flag (R-23 mitigation) is intentionally never reset by automation. If a SKU was mistakenly switched into per-location mode (e.g., a test session, an erroneous count) and the operator wants to revert it to single-location SKU-total fanout:

```sql
-- 1) Audit first: confirm no real per-location data exists
SELECT vl.location_id, l.name, vl.quantity
FROM warehouse_variant_locations vl
JOIN warehouse_locations l ON l.id = vl.location_id
JOIN warehouse_product_variants v ON v.id = vl.variant_id
WHERE v.sku = '<sku>';

-- 2) If output is empty (or all rows are 0/draft), reset:
UPDATE warehouse_inventory_levels
SET has_per_location_data = false
FROM warehouse_product_variants v
WHERE warehouse_inventory_levels.variant_id = v.id
  AND v.sku = '<sku>'
  AND has_per_location_data = true;
```

**Caveat:** if ShipStation v2 still has per-location records for this SKU from a previous run, the next single-location SKU-total write will create a third record (workspace-default location), and the SKU's aggregate will be wrong. Run the §15.3 GATE probe outcome 1 logic mentally before resetting; ideally also clear the ShipStation per-location records via the v2 API. For most realistic operator scenarios (test SKU, brand-new product) this caveat does not apply.

## §20. Rejected alternatives

- **Multi-day burn-in.** Original Phase 6 closeout assumed a 7-day burn-in before ramp. Rejected because the operator's hard deadline is Tue 09:00 and the warehouse cannot operate without inventory truth. Instead: compressed 0% → 10% → 50% → 100% ramp over Sun/Mon with operator-attended UX dry runs after every step.
- **Adapt the dormant `/admin/scan` count UI.** Considered to leverage existing scaffolding. Rejected because (a) staff are doing visual counts, not scanner counts; (b) `submitCount` in `scanning.ts` writes to `warehouse_variant_locations` directly without going through `recordInventoryChange()`, violating Rule #20; (c) extending it would require fixing the bypass first, which is more work than building the count session in a clean Server Action file.
- **Threshold-based fanout suppression** ("trust the count if delta < 3 units, otherwise hold"). Considered as a simpler alternative to count sessions. Rejected because it doesn't compose with multi-bin counts — three bins each off by 2 produces a 6-unit total drift that crosses the threshold but the partial pushes during entry already overshoot. Count sessions handle this correctly.
- **Store ShipStation inventory totals client-side and re-compute in our app.** Considered to avoid the per-location ShipStation push complexity. Rejected because warehouse staff use ShipStation's pick lists when fulfilling — they need to see the per-location truth in ShipStation's UI, not just our app's.
- **Bidirectional location sync (ShipStation → our app).** Considered for completeness. Rejected because operator is committing to "all location management happens in our app". Bidirectional sync would risk us overwriting fresh local edits with stale ShipStation data. Reverse direction can be added in a future phase if needed.
- **Active deletion of stale ShipStation v2 locations.** Considered to clean up immediately. Rejected because the existing locations have residual inventory we don't want to disturb mid-week. They atrophy as inventory hits 0; operator can run a manual cleanup script later.
- **Per-Server-Action ShipStation queue.** Considered to make `createLocation` enqueue a Trigger task instead of calling ShipStation inline. Rejected because the operator UX expects the ShipStation mirror status (synced/error) to be available immediately on the result of `createLocation` — async would force the UI to poll. Volume is bounded enough to justify inline.
- **A `bandcamp-push-on-sku`-style focused ShipStation task with the same queue serialization story.** This IS what `shipstation-v2-sync-on-sku` becomes — not rejected, just naming clarification.
- **Defer the per-location rewrite of `shipstation-v2-sync-on-sku` to next week.** Considered to absorb the Saturday workload. Rejected because then ShipStation's UI would show wrong per-location data starting Tue, defeating the purpose of mirroring locations. Per-location semantics ship Saturday or the locator system isn't useful Tuesday.

## §21. Open questions

These are NOT blocking but should be answered before/during implementation; flagging here for reviewer awareness.

- **OQ-1.** ~~Does ShipStation v2 enforce a uniqueness constraint on location names within a warehouse?~~ **ADDRESSED 2026-04-19 review pass.** C.7 `createLocation` now catches 409/duplicate from ShipStation, fetches existing ID via `listInventoryLocations({ name })`, stores it locally with `warning: 'shipstation_mirror_resolved_existing'`. Idempotent against stale pre-existing ShipStation locations. Tracked as R-22.
- **OQ-2.** ~~What is ShipStation v2's behavior when a SKU has inventory at multiple locations and we `modify new_available: 0` at one of them?~~ **ADDRESSED 2026-04-19 review pass.** Verified by §15.3 GATE probe outcome 2 (must run before per-location rewrite ships). Expected behavior per Patch D2: `modify new_available: 0` rejects, `adjust quantity: 0` works for previously-seeded location. C.5 already implements this. R-20 covers the unseeded edge case.
- **OQ-3.** Should `cancelCountSession` with `rollbackLocationEntries: false` keep the per-location entries marked as "draft" somehow, or is there no distinction from regular per-location data? Plan default: no distinction. Reviewer may push back.
- **OQ-4.** Is the spot-check artifact required to be a markdown file, or is the JSON `summary_json` enough? Plan default: both — the markdown is operator-friendly, the JSON is machine-parseable for a future dashboard.
- **OQ-5.** Should `getTodayCountProgress()` count only the current authenticated user's changes, all staff, or both? Plan default: both, displayed as "127 (you) / 143 (all)".

## §22. Deferred items

Tracked in `docs/DEFERRED_FOLLOWUPS.md` with due dates. Reminder cron surfaces them to the warehouse review queue on the due date.

| Slug | Title | Due | Severity |
|---|---|---|---|
| `phase-7-dormant-cleanup` | Phase 7: dormant client-store code cleanup | 2026-07-13 | medium |
| `tier1-9-better-stack` | Tier 1 #9: Better Stack synthetic monitoring | 2026-05-13 | high |
| `tier1-10-statuspage` | Tier 1 #10: statuspage.io public status page | 2026-05-13 | high |
| `external-sync-events-retention` | Verify 7-day retention cron is firing | 2026-04-25 | low |
| `shipstation-stale-location-cleanup` | Run `scripts/cleanup-stale-ss-locations.ts` (Thursday Apr 23 first run): queries v2 for all locations with `available: 0` AND not in our `warehouse_locations.shipstation_inventory_location_id` set; prints list; with `--apply` flag, deletes them via `deleteInventoryLocation`. Reduces ShipStation pick-list UI clutter from atrophied locations (reviewer 1 §1). | 2026-04-23 | medium |
| `inventory-locator-bidirectional-sync` | Add ShipStation → our-app location sync if requested by warehouse ops | TBD | low |
| `wake-lock-and-sessionstorage` | Re-evaluate Rule #50 wake lock + sessionStorage when scanners arrive | TBD | medium |
| `fanout-guard-sku-deterministic` | (R-24) Refactor `fanout-guard.ts isInRolloutBucket` to hash on `(workspaceId, sku)` instead of correlation_id, so per-SKU rollout decisions are stable across events. Frozen primitive — needs Rule #38 hotfix-from-main protocol. | 2026-05-13 | medium |
| `per-bin-sale-routing` | (R-19 long-term fix) Route Bandcamp/ShipStation sale decrements to specific `warehouse_variant_locations.quantity` rows based on order-line-to-location mapping. Eliminates count-session race ambiguity. Requires reconciler pass on `warehouse_orders`. | 2026-07-13 | medium |
| `migration-ordering-from-scratch` | (v6 finding) `supabase/migrations/20260417000001_sku_rectify_infrastructure.sql` creates `external_sync_events`, but `20260413000010_tier1_hardening.sql` adds an index on it and `20260413000030_phase5_…` creates a view querying it — both lexicographically earlier. Live DB unaffected (write order ≠ filename order historically), but a `supabase db reset` from scratch fails. Fix: split the table-creation portion of `20260417000001` into a new `20260413000005_external_sync_events_create.sql` so creation runs before consumers. Operator-only — does not block ramp. | 2026-05-15 | low |
| `shared-utils-path` | (v6 finding) Rule #57 specifies `src/lib/shared/utils.ts` for shared formatting/cn helpers, but the codebase has `src/lib/utils.ts` (only `cn` + `maxShippingFromOrderLineItems`). Decision: either create `src/lib/shared/utils.ts` and re-export from `src/lib/utils.ts`, OR amend Rule #57 to point at the actual location. Track to keep new code from duplicating utilities. | 2026-05-15 | low |
| `role-matrix-rename` | (v6 finding) Rule #40 specifies `ROLE_MATRIX` constant; codebase exports `STAFF_ROLES` and `CLIENT_ROLES` from `src/lib/shared/constants.ts`. Either add a `ROLE_MATRIX` alias or update Rule #40. Builds work today. | 2026-05-15 | low |
| `scanning-auth-audit` | (v6 finding) `src/actions/scanning.ts` actions (`lookupLocation`, `lookupBarcode`, `submitCount`, `recordReceivingScan`) do not call `requireStaff()` — they rely on middleware. Plan deprecates `/admin/scan` for Tuesday onboarding so the gap is moot, but if `/admin/scan` is ever re-enabled, audit and add `requireStaff()` calls before. | 2026-06-01 | medium |

## §23. Revision history

| Date | Author | Change |
|---|---|---|
| 2026-04-16 | claude (compressed weekend agent) | v1 of `shipstation-source-of-truth-plan.md` — initial pivot away from Shopify hardening (preserved as Appendix H) |
| 2026-04-13 | claude (compressed weekend agent) | v2 — restructured into the 8 required output sections + standardized body + appendices. Closeout work folded in from `~/.cursor/plans/megaplan_closeout_…_0056b39e.plan.md`. Locator + count session + ShipStation mirror added per operator requests. Saturday compression accepted at ~22 hr. |
| 2026-04-13 | claude (review pass integration) | v3 — review pass hardenings adopted. Changes: (a) §15.3 GATE inserted as hard gate before per-location rewrite ships (3-case probe), (b) A-6 elevated to PROBE REQUIRED, (c) §17 added R-19 (in-flight sale during count session) + R-20 (unseeded location zero-write) + R-21 (createLocationRange rate limit) + R-22 (createLocation 409), (d) §17.1 Hardenings table added, (e) C.5 unseeded-zero skip path, (f) C.7 createLocation 409 resolution + createLocationRange 250ms throttle, (g) §27.3 operator guidance for low-shipping count windows, (h) §15.6 fallback priority restructured to make 3f conditional on 3e probe outcome, (i) OQ-1 + OQ-2 marked addressed, (j) §27.3 step count 7→8 reflecting new probe gate. No code-base changes yet — plan-only update. |
| 2026-04-13 | claude (review pass v4 integration) | v4 — second review pass hardenings adopted. KEY CORRECTION: count session formula reverted from `delta = sum - baseline` (v3, wrong for typical Scenario A) to `delta = sum - current_available` (v4, correct trade-off favoring under-decrement over over-decrement). Baseline column retained for audit metadata. Other changes: (a) C.2 + C.5 + C.8 added sticky `has_per_location_data` flag — R-23 prevents SKU oscillation between per-location and SKU-total fanout, (b) C.7 `updateLocation` reordered to call ShipStation FIRST on rename, local update only on success, (c) C.3 spot-check excludes count_in_progress SKUs from sample, (d) C.3 ramp-window sampling: 15 SKUs (vs 5 daily) prioritized by recent activity, (e) C.3 persistence rule: drift_major must repeat 2 consecutive runs before review queue item, (f) §17 added R-23 (per-location oscillation) + R-24 (event-deterministic rollout), (g) §16 added A-22, A-23, A-24, (h) §22 added two new deferred items: `fanout-guard-sku-deterministic` (2026-05-13) + `per-bin-sale-routing` (2026-07-13), (i) §17.1 split into v3 + v4 subsections. No code-base changes yet — plan-only update. |
| 2026-04-13 | claude (review pass v5 integration) | v5 — third review pass (two reviewers) hardenings adopted. **CRITICAL FIX (Vercel Server Action timeout, reviewer 1 §3):** `createLocationRange` now caps inline path at 30 entries (~12s budget); ranges >30 route to new `bulk-create-locations` Trigger task (Appendix C.17) which uses `shipstationQueue` for serialization and has no execution-time ceiling. Throttle bumped 250ms→300ms for safety margin against shared 200 req/min v2 rate bucket (reviewer 2 §2). **DDL gap fix (reviewer 2 §3):** §15.2 migration body listing was missing `has_per_location_data` (only Appendix C.2 had it) — added; comment block updated from v3 (baseline-based semantics) to v4 (audit-only). Other changes: (a) §19.6 added `has_per_location_data` manual reset escape valve documenting the operator-gated SQL recovery path (reviewer 2 §1), (b) `shipstation-stale-location-cleanup` deferred item moved up to 2026-04-23 (Thursday) with concrete script spec (reviewer 1 §1 — UI pollution from atrophied locations), (c) §17 R-21 expanded to cover Vercel timeout + shared rate bucket failure modes, (d) §17.1.c v5 hardenings table added, (e) Appendix C.17 added with full `bulk-create-locations` Trigger task skeleton. Acknowledged as known limitations without plan changes: C.8 microsecond Redis-PG read race (reviewer 1 §2 — true fix is absolute-set-in-RPC, deferred), spot-check read skew (reviewer 1 §4 — already mitigated by persistence rule). No code-base changes — plan-only update. |
| 2026-04-18 | claude (1hr post-closeout sprint #2) | v9 — closed slug `ws3-3g-locations-admin-page` (also resolves item (3) of `ws3-ux-polish-sunday`). Shipped `src/app/admin/inventory/locations/page.tsx` — full operator surface for `warehouse_locations`: search + filter (location_type, active-only/all) + at-a-glance ShipStation v2 sync state per row (Synced ✓ / Local only / Mirror failed ✕ — last surfaces `shipstation_sync_error` on hover) + Last-synced relative time + one-click Retry button on rows with `shipstation_sync_error` (calls `retryShipstationLocationSync`, handles `NO_V2_WAREHOUSE` and `alreadySynced` paths) + Deactivate button (refuses on `LOCATION_HAS_INVENTORY` with explicit guidance toast) + New-location dialog (calls `createLocation`, surfaces all four `CreateLocationWarning` variants — `null`/`shipstation_mirror_resolved_existing`/`shipstation_mirror_failed`/`no_v2_warehouse_configured` — as distinct toasts) + New-range dialog (calls `createLocationRange`, displays inline-vs-Trigger badge live based on size with the §15.5 cap of 30, surfaces created/exists/error counts on completion). Inline rename intentionally deferred (Server Action calls v2 first per v4 §17.1.b — failure UX needs more than a 1hr sprint). Sidebar `NAV_ITEMS` gained "Locations" entry under Inventory (re-uses `Warehouse` icon). No new tests added — page is pure UI plumbing over the already-tested `src/actions/locations.ts` (those tests cover all warning paths the dialogs surface). Quality gates: typecheck + biome + 112 files / 1084 vitest tests all green. Doc sync: `docs/DEFERRED_FOLLOWUPS.md` `ws3-3g-locations-admin-page` slug marked `status: done`/`done_at: 2026-04-18` with full closeout context; `ws3-ux-polish-sunday` slug retitled to note items (1)+(3) DONE; closeout Follow-up tasks table extended with a Status column and the two completed slugs annotated. Remaining Sunday work: only item (2) bulk Avail edit + the `ws3-ux-dry-run-1` smoke test. |
| 2026-04-18 | claude (1hr post-closeout sprint) | v8 — knocked off item (1) of slug `ws3-ux-polish-sunday`: per-row count-status indicators on `/admin/inventory`. `InventoryRow` interface gained `countStatus` / `countStartedAt` / `countStartedByName`; `getInventoryLevels` (and its search-fallback variant) now select `count_status, count_started_at, users:count_started_by(id,name)` via PostgREST embedded join — works because migration `20260418000001` added the FK `warehouse_inventory_levels.count_started_by → public.users(id)`. Client-facing `getClientInventoryLevels` hard-nulls all three fields so internal staff workflow state never reaches the portal. UI: amber "Counting…" badge with pulsing dot + "Xm ago" + "by NAME" subline rendered inside the title cell when `count_status='count_in_progress'`. Inline `formatRelativeTimeShort` helper added (third site of the same pattern in the codebase — consolidation tracked under `shared-utils-path` deferred slug). Companion test `tests/unit/actions/inventory.test.ts` updated. Quality gates: typecheck + biome + 112 files / 1084 vitest tests all green. Doc sync: `docs/DEFERRED_FOLLOWUPS.md` `ws3-ux-polish-sunday` entry annotated with PROGRESS marker noting item (1) DONE; closeout Follow-up tasks table cross-referenced. Remaining Sunday items: bulk Avail edit + standalone `/admin/inventory/locations` page (slug `ws3-3g-locations-admin-page`). |
| 2026-04-18 | claude (build closeout) | v7 — post-build closeout. Added "Part IV — Build closeout (2026-04-18)" before Appendix A with the 8 required closeout sections: Final outcome (WS1 + WS2 + WS3 3a–3d shipped green; WS3 3f deferred at §15.3 GATE per `stop_at_3d`; WS3 3g deferred to Sunday), Implementation notes (WS1 migration pre-shipped WS3 schema, `InventorySource` union widened in WS2, sibling-task pattern for `shipstation-v2-adjust-on-sku` + `bulk-create-locations`, v4 `completeCountSession` delta formula, sticky `has_per_location_data` flag, `updateLocation` calls v2 first on rename, `createLocationRange` 30-entry inline cap, 409 conflict resolution via `listInventoryLocations`, panel-in-existing-expanded-row UI choice, two test-file biome ignores), Deviations from plan (panel vs full re-design, 3g deferred to Sunday, 3f deferred at gate, WS1 migration bundled, WS2 sibling task added, types union widening, biome ignores), Final files changed (WS1 + WS2 + WS3 + doc-sync), Follow-up tasks (§15.3 probe + §3f + §3g + Sunday UX polish + UX dry-run #1), Deferred items (updated — added 4 new entries: `ws3-3f-per-location-rewrite`, `ws3-3g-locations-admin-page`, `ws3-ux-polish-sunday`, `ws3-ux-dry-run-1`), Known limitations (per-location v2 not live, no standalone locations page, one-way location sync, no count-session row lock, bulk-create partial-failure surfacing is one queue item per task run, no force-deactivate, desktop-first UI, no lint guard against bypassing `recordInventoryChange`), and What we learned (pre-shipping schema in upstream WS, sibling-task pattern, diff-against-current-available is the highest-stakes design call, halt-here-pending-evidence checkpoints are honest, biome ignore for intentional Supabase thenable, expanded-row real estate is undervalued, doc-sync-as-you-go beats doc-sync-at-end, TS-union ↔ DB-check-constraint drift is worth a future CI guard). No code changes — closeout-only. Quality gates green at close: typecheck + biome + 112 vitest files / 1084 tests. |
| 2026-04-13 | agent (v6 codebase verification pass) | v6 — pre-build triple-check against live `src/` and `supabase/migrations/`. **5 compile-blocking renames fixed:** (a) `createServerActionClient` → `await createServerSupabaseClient()` everywhere (the former does not exist in `src/lib/server/supabase-server.ts`; latter is async — added 13 `await` keywords), (b) `requireStaff()` destructuring `{ user, workspaceId }` → `{ userId, workspaceId }` (the actual return type is `{ userId: string; workspaceId: string }` per `src/lib/server/auth-context.ts`), (c) `user.id` → `userId` in 5 dependent expressions, (d) NFR-6 factory name corrected. **1 functional gap fixed:** `megaplan_sample_skus_per_client` RPC SQL written into C.3 (was referenced as "added in same migration" but never defined); recommended renumbering spot-check migration `40` → `60` so it sequences after Migration 50's `count_status` column. **1 doc-accuracy fix:** B.9.6 `adjustInventory` excerpt replaced with verbatim source from `src/actions/inventory.ts` lines 313–345 (was a fabricated `getStaffContext()` shape). **4 already-shipped findings noted (no plan change required):** `shipstation_v2` already in `ExternalSyncSystem` union, `workspaces.shipstation_sync_paused` already exists from `20260413000010_tier1_hardening.sql`, `fanout-guard.ts PAUSE_COLUMN` already maps `"shipstation"`, `shipstationQueue` already exists with `concurrencyLimit: 1`. **4 pre-existing concerns flagged as deferred:** migration ordering bug (`20260417000001` creates `external_sync_events` after migrations index/view it — affects from-scratch resets only), `src/lib/shared/utils.ts` does not exist (Rule #57 aspirational), `ROLE_MATRIX` does not exist (Rule #40 aspirational — codebase uses `STAFF_ROLES`), `scanning.ts` lacks `requireStaff()` (deprecated path). **§17.1.d v6 hardenings table added** with the full plan-vs-codebase mapping. **Build-day dry-run gate recommended:** paste C.6 + C.7 + C.8 to a feature branch and `pnpm typecheck` — if clean, v6 verification held. No code-base changes — plan-only update. |

---

# Part III — Operator-facing material

The eight sections below are the operator-friendly weekend pacing material. They mirror the body of the prior Cursor-internal plan with no functional changes. Engineering reviewers can skim.

## §24. Plain-language summary

By Tuesday morning when staff arrive, seven things have to be true:

1. **Staff can open the Inventory page, click the "Avail" number for any SKU, type the real count, and have that number push to Bandcamp + ShipStation automatically.** Today the click-to-edit pushes to Bandcamp but not yet ShipStation. This plan fixes that.
2. **Staff can label a shelf or bin physically, create the matching location record in the system, and assign SKUs to that location — all without leaving the Inventory page.** No locator UI exists today; this plan builds it.
3. **Staff can do a per-bin count without overselling Bandcamp mid-process.** When you count one bin of a SKU but haven't counted the other bins yet, the system holds the new total back from external systems until you confirm the SKU's count is complete. Then it pushes the final number once.
4. **Every location staff create in our app gets created in ShipStation too, and per-location inventory flows to ShipStation per-location, not as one big bucket.** Our app is the source of truth for warehouse layout. ShipStation's existing stale location data is superseded as new per-location inventory writes arrive — staff using ShipStation pick lists see the same bin labels staff using our app see.
5. **Bandcamp and ShipStation both see every confirmed inventory change automatically** — counts, sales, shipments, manual fixes. (Order *routing* already works — ShipStation pulls Bandcamp orders natively. What we're turning on is *inventory parity* in both directions.)
6. **The big plan we've been working on is closed and out of the way** — moved into a "finished work" folder so neither you nor the agent is still tracking it. New work starts on a clean slate.
7. **You have a signed page on file** that lists what was checked, what passed, and what was deferred — so when something looks weird in two weeks you can look back and say "yes, this was known."

## §25. Glossary (operator quick reference)

- **The fanout** — When inventory changes for any reason, "the fanout" is the automatic broadcast that pushes the new number to Bandcamp, Shopify, ShipStation, etc. Today the fanout pushes to Bandcamp but not yet to ShipStation v2. Fixing that is required to enable live counting.
- **Bridge / `fanout_rollout_percent`** — A safety dial. At 0% inventory changes are calculated and logged but not actually pushed to external systems. At 100% every change pushes immediately. The weekend ramps from 0 to 100 in stages.
- **Locator system** — A way to label and track *where* in the warehouse each SKU physically lives (e.g. "Shelf A row 12 bin 3"). Schema for this exists in the database from day one but no UI was ever built. This plan adds the UI.
- **Location** — A named place in the warehouse: a shelf, a bin, a floor area, a staging zone. Each has a name (e.g. "A-12-3"), a type, and optionally a barcode for future scanner support. Each location our app creates is mirrored to ShipStation so picking staff using ShipStation see the same bin names.
- **ShipStation location mirror** — When `createLocation()` runs in our app, it also calls `POST /v2/inventory_locations` and stores the returned `inventory_location_id`. From that point on, per-location inventory writes target ShipStation's matching ID. Existing stale ShipStation locations are NOT actively deleted this weekend — they're just no longer written to and atrophy. Operator can clean them up manually in ShipStation's UI later.
- **Count session** — A short-lived state on a SKU that says "we are actively counting this right now, don't push partial numbers to Bandcamp/ShipStation yet." Started by clicking "Start count" on a SKU's row. While active, per-location quantities you enter are saved but not pushed externally. Sales and shipments still flow normally during a count session. Ended by clicking "Complete count" (final per-location total replaces SKU total, fanout fires once) or "Cancel count" (per-location entries kept as draft data, no fanout).
- **Spot-check** — An automated inventory verification that compares what we think we have (database) against what Bandcamp and ShipStation actually show, for a sample of SKUs per client. Fires after every ramp step.
- **Tier 1 #9 / #10** — Two monitoring tools (Better Stack uptime checks, statuspage.io public status page) that the mega-plan listed as required before 100% rollout. We're going to formally waive them with a 30-day deadline so we can hit 100% Monday and onboard staff Tuesday.

## §26. Your weekend at a glance

- **Sat ~22:00 (after a long agent build day)** — pause everything; agent does release gate + db push + deploy. ~5 min of your time confirming we deployed.
- **Sun ~10:00** — UX dry run #1 on `/admin/inventory` (~30 min): (a) click an Avail cell, change a SKU's count, watch toast + Bandcamp + ShipStation update within 60s; (b) on a different SKU, click "Start count," add 2 location entries (one new label like "TEST-A-1" — verify it also appears in ShipStation's locations list within ~10s, one existing already-mirrored location), click "Complete count," verify external systems update only after completion not during AND verify that ShipStation now shows the SKU's inventory split across the matching locations rather than as one bucket.
- **Sun ~12:00** — agent ramps bridge to 10%; spot-check runs. ~5 min check from you at 14:00.
- **Sun ~16:00** — agent ramps to 50%; spot-check runs. ~5 min check at 18:00.
- **Mon ~09:00** — agent ramps to 100%; spot-check runs. ~5 min check from you.
- **Mon ~14:00–15:00** — UX dry run #2 (~45 min): pick 3 real shelves, label them physically, create the location records inline from the count session UI, count 3-5 SKUs per shelf using the start → add-locations → complete flow. Time yourself per SKU and per shelf. This is the realistic pace staff will work at Tue/Wed.
- **Mon ~17:00–18:00** — final spot-check + you sign Section E of the verification artifact (including Tier 1 #9/#10 waiver text). Agent moves the mega-plan into the archive folder. ~10 min.
- **Tue 09:00** — staff arrive, label-and-count their way through the warehouse on `/admin/inventory` with bridge at 100%.

Total operator time across the weekend: ~95 minutes spread across six checkpoints. Hard deadline: Tue Apr 21 09:00.

## §27. Saturday Apr 18 — what ships, in what order

Total agent build time: **~22 hr** across three workstreams + 30 min release gate / deploy. This is a long single calendar day. Operator has explicitly accepted the one-day-pace risk. Sunday morning adds ~2.25 hr of UX polish before the 10:00 dry run.

**Documented fallback if Saturday slips:** Workstreams 1 (closeout) and 2 (basic ShipStation v2 fanout for SKU totals) are the highest priority — they unblock the ramp Sunday/Monday using the existing Avail-cell flow. Workstream 3 has internal staging: locations Server Actions + count session backend + ShipStation client extensions are the priority sub-tasks; the standalone Locations admin page table view and the "stale ShipStation cleanup" considerations are explicitly skipped Saturday and slip to next week if needed. The Inventory page expanded-row count UI is critical for Tue/Wed and ships even if the Locations admin page doesn't.

### §27.1. Workstream 1: closeout deliverables (~6 hr)

1. **Migration 40** — `supabase/migrations/20260413000040_megaplan_spot_check_runs.sql` — new table `megaplan_spot_check_runs` (DDL in §15.1).
2. **`src/trigger/tasks/megaplan-spot-check.ts`** — new Trigger task. Pinned to `shipstationQueue`. Schedule: hourly during ramp weekend, then daily.
3. **Server Actions** — `src/actions/megaplan-spot-check.ts` exports `triggerSpotCheck()`, `listSpotCheckRuns()`, `getSpotCheckArtifact(runId)`. Companion test file in `tests/unit/actions/megaplan-spot-check.test.ts`.
4. **Admin page** — `src/app/admin/settings/megaplan-verification/page.tsx`.
5. **Reminder cron** — `src/trigger/tasks/deferred-followups-reminder.ts`. Daily.
6. **`docs/DEFERRED_FOLLOWUPS.md`** — initial entries listed in §22.
7. **`docs/MEGA_PLAN_VERIFICATION_2026-04-13.md`** — pre-filled Sections A–D; E left blank.
8. **Trigger registration + doc sync** — register all three new tasks; update API/Trigger catalogs, engineering_map, journeys, TRUTH_LAYER, CLAUDE.
9. **CLAUDE.md Rule #73** — `vi.resetAllMocks()` over `vi.clearAllMocks()`.
10. **Cleanup batch** — fix the 3x `supabase as any` and unused `beforeEach` import in `tests/unit/lib/billing-rates.test.ts`.

### §27.2. Workstream 2: live-counting backend fix (~4 hr)

1. **Migration 50** — DDL in §15.2.
2. **Type extensions** — `src/lib/shared/types.ts` per §15.2.
3. **Fanout extension** — `src/lib/server/inventory-fanout.ts` adds the fourth target.
4. **New Trigger task** — `src/trigger/tasks/shipstation-v2-sync-on-sku.ts` initial SKU-total path.
5. **Tests** — extend `inventory-fanout.test.ts` + new `shipstation-v2-sync-on-sku.test.ts`.

### §27.3. Workstream 3: locator system + per-SKU count session + ShipStation mirror (~12 hr including probe gate)

**Operator note (R-19):** Tuesday/Wednesday counting sessions should happen during low-shipping windows (typically 09:00–11:00 ET before the daily ShipStation pick wave). For high-velocity SKUs with active orders queued, complete a count session within 30 min of starting it. The system tolerates one in-flight sale per session (the snapshot pattern absorbs it cleanly), but multiple sales from a bin that's already been counted but before "Complete count" is clicked will produce a small discrepancy that the spot-check catches as `drift_minor` for next-cycle correction.

1. **ShipStation v2 client extensions** (~30 min) — see Appendix C.11. Includes `listInventoryLocations({ name })` for the C.7 OQ-1 hardening lookup.
2. **Locations Server Actions** (~1.5 hr) — see Appendix C.7. Includes 409 resolution + 250ms range throttle.
3. **Per-SKU count session Server Actions** (~1.5 hr) — see Appendix C.8. Includes baseline snapshot (R-19 mitigation).
4. **Locations admin page** (~2 hr) — see Appendix C.10.
5. **Inventory page expanded-row count UI** (~2.5 hr) — see Appendix C.13.
6. **§15.3 GATE — per-location semantics probe** (~30 min). REQUIRED before step 7 deploys. Three test cases against dev SKU; outcomes recorded in MEGA_PLAN_VERIFICATION Section A. If outcome 1 fails: skip step 7 entirely, leave the SKU-total fallback path from WS2 in place, file deferred item.
7. **Per-location rewrite of `shipstation-v2-sync-on-sku`** (~1.5 hr, gated by step 6) — see Appendix C.5. Includes unseeded-zero skip path (R-20).
8. **Tests** (~1 hr beyond per-action tests). Includes the R-19 sale-during-session integration test asserting the snapshot is used.

### §27.4. Saturday late evening — release gate + deploy (~30 min)

1. `pnpm release:gate` end-to-end.
2. **Pre-flight (v6 hardening):** `pnpm typecheck` on the feature branch with C.6 + C.7 + C.8 pasted as written. If it errors, pause — the v6 verification missed something. Fix the divergence and add a v7 entry to §17.1 + §23 before continuing.
3. `supabase db push --yes`.
   - **Operator note (v6 finding — does NOT block this push):** A pre-existing migration ordering bug exists in the repo (`20260417000001_sku_rectify_infrastructure.sql` creates `external_sync_events` AFTER `20260413000010_tier1_hardening.sql` indexes it and `20260413000030_phase5_…` views it). The live DB applied them in real-time write order so it's intact, but a future `supabase db reset` from scratch would fail. Tracked as deferred item `migration-ordering-from-scratch` (due 2026-05-15). Today's `db push` is unaffected because it appends new migrations only; it does NOT replay the older ones.
4. Vercel production deploy.
5. First automated spot-check fires manually via `triggerSpotCheck()`. Bridge stays at 0%.

## §28. Sunday Apr 19 — UX polish, then accelerated ramp + UX dry run #1

### §28.1. Sunday early morning — UX polish (~2.25 hr, finishes by ~09:30)

1. **Toast feedback on inline-edit save** (~30 min).
2. **Recently-edited row indicator** (~30 min).
3. **"Set to" toggle in the Adjust dialog** (~45 min).
4. **Daily count-progress counter at the page top** (~30 min) — `getTodayCountProgress()` Server Action in `src/actions/inventory.ts`.

Then a quick re-deploy (Vercel) before the dry run.

### §28.2. Ramp + checkpoints

- **~10:00 — operator UX dry run #1** (~25 min):
  - Part A (~10 min): Avail cell edit on any SKU; verify toast + Bandcamp + ShipStation within 60s.
  - Part B (~15 min): start count on a different SKU; add 2 location entries (one new TEST-A-1, one existing); complete; verify external systems update only on completion.
  - If anything fails, halt the ramp.
- **~12:00** — agent runs `UPDATE workspaces SET fanout_rollout_percent = 10` for the Clandestine workspace. Spot-check fires.
- **~14:00 — operator 5-min check** — verification page + sensor health.
- **~16:00** — agent ramps to 50%; spot-check fires.
- **~18:00 — operator 5-min check** — verification page + sensor health.

## §29. Monday Apr 20 — finalize + dry-run the locator-count flow

- **~09:00 — operator 5-min check** (overnight reconcile + spot-check trends). If green, ramp to 100%.
- **~14:00–15:00 — operator UX dry run #2** (~45 min): three real shelves, label, create inline, count 3–5 SKUs per shelf using start → add-locations → complete. Time yourself per shelf and per SKU.
- **~17:00–18:00 — final spot-check + signoff** (~10 min):
  - Agent runs final `triggerSpotCheck()`.
  - Operator opens `docs/MEGA_PLAN_VERIFICATION_2026-04-13.md`, fills Section E (ramp evidence, spot-check evidence, dry run results, Tier 1 #9 + #10 waiver text, signature + date).
  - Agent moves `~/.cursor/plans/b_a2a879fa.plan.md` to `docs/archive/mega-plan-2026-04-13.md`.
  - Agent enables the deferred-followups reminder cron.

## §30. Tuesday Apr 21 — staff arrive

- Bridge live at 100%, mega-plan archived, reminder cron live, spot-check running daily.
- Staff workflow: open `/admin/inventory`, filter to one client, walk to a shelf, label it, expand a SKU, click "Start count," add per-location entries (creating new location names inline as needed), click "Complete count." Toast + row highlight confirm fanout fired. Move to next SKU/shelf.
- For SKUs that only live in one bin or staff don't need per-location accuracy on: just click the Avail cell and type the count — that path still works for the simple case.

## §31. When the agent halts the ramp on its own

- `release:gate` fails Saturday → no deploy, page operator immediately.
- UX dry run #1 Part A (Sun ~10:00) shows Bandcamp or ShipStation didn't update within 60s after an Avail cell edit → don't ramp to 10%.
- UX dry run #1 Part B shows Bandcamp or ShipStation DID update during the in-progress phase of a count session (i.e. fanout suppression broken) → don't ramp. This is the canary for the count session invariant.
- Any spot-check fires `drift_major` for >5% of sampled SKUs → don't escalate.
- Phase 5 reconcile sensor goes red → don't escalate.
- ShipStation v2 5xx error rate >2% over a 30-min window during ramp → set `shipstation_sync_paused = true`, page operator.
- Count session abandonment: any SKU in `count_in_progress` for >24 hours → review queue item (severity: medium) reminding the operator to either complete or cancel.
- ShipStation location mirror failure rate >10% over the last hour → pause new location creation in our app and surface a banner.

## §32. What we're knowingly skipping for now (with deadlines)

- **Better Stack synthetic monitoring (Tier 1 #9)** — Deferred to 2026-05-13. Compensating control: hourly spot-check + manual operator check during week 1.
- **statuspage.io public status page (Tier 1 #10)** — Deferred to 2026-05-13. Compensating control: email clients directly during incidents.
- **Phase 7 dormant code cleanup** — Deferred 90 days to 2026-07-13.
- **Scanner-based count flow** (`/admin/scan` Count tab) — dormant infrastructure for when hardware scanners arrive. Manual visual entry on `/admin/inventory` (with the new locator + count session UI) is the staff workflow until scanners exist.
- **Label printing / barcode generation for new locations** — no integration with a label printer for Tuesday.
- **Active deletion of stale ShipStation locations** — atrophy strategy.
- **Bidirectional location sync (ShipStation → our app)** — only our-app → ShipStation is wired.

---

# Part IV — Build closeout (2026-04-18)

This section is the post-build record of what actually shipped across Saturday Workstreams 1, 2, and 3. The pre-build plan body above (§§1–32) is preserved as-is so audit can diff plan vs delivery. Where delivery diverged, it's called out under "Deviations from plan."

## Final outcome

All three Saturday workstreams shipped green. WS3 was halted after sub-task 3d (per the operator's `stop_at_3d` decision) so the per-location rewrite of `shipstation-v2-sync-on-sku` (3f) and the standalone `/admin/inventory/locations` admin page (3g) are deferred — see "Follow-up tasks" below for the resume contract.

| Workstream | Scope | Status | Quality gate |
|---|---|---|---|
| WS1 — Mega-plan closeout | `megaplan-spot-check` task + `/admin/settings/megaplan-verification` UI + `deferred-followups-reminder` cron + `docs/DEFERRED_FOLLOWUPS.md` registry + signed `docs/MEGA_PLAN_VERIFICATION_2026-04-13.md` artifact + count-session/location schema columns pre-shipped in WS1 migration so WS3 needed no SQL | shipped | typecheck + biome + vitest green |
| WS2 — Manual inventory count entry | `/admin/inventory/manual-count` bulk-table editor + `submitManualInventoryCounts` Server Action + new `shipstation-v2-adjust-on-sku` Trigger task (sibling of `shipstation-v2-decrement`, handles BOTH directions of delta) + companion test (13 cases) | shipped | typecheck + biome + vitest green |
| WS3 3a–3d — Count sessions + locations source-of-truth | ShipStation v2 client extensions (create/update/delete inventory location) + count-session Server Actions + warehouse-locations Server Actions + `bulk-create-locations` Trigger task + `InventoryCountSessionPanel` mounted in the existing `/admin/inventory` expanded-row detail | shipped | typecheck + biome + vitest green (112 files / 1084 tests) |
| WS3 3f — Per-location rewrite of `shipstation-v2-sync-on-sku` + `fanoutInventoryChange` v2 enqueue | gated by §15.3 ShipStation v2 per-location semantics probe | **deferred** | n/a until probe outcome reported |
| WS3 3g — Standalone `/admin/inventory/locations` admin page | inline create from count UI covers Tue/Wed onboarding | **deferred to Sunday** | n/a |

By Tuesday morning, the seven invariants from §24 are met for the parts of WS3 that shipped. The deferred §15.3-gated path keeps writing through the SKU-level v2 fanout (now actually wired — see "Post-audit fixes" below) in the meantime; the sticky `has_per_location_data` flag is in place and will be the pivot key when the rewrite resumes.

## Post-audit fixes (2026-04-13)

A post-build audit ("Audit pass A — 2026-04-13") compared the plan body against the codebase and surfaced five findings (F1–F5). Three were behavioral (F1/F2/F3); two were doc-only (F4/F5). All five closed in a single follow-up commit on 2026-04-13. The pre-audit `Final outcome` table above describes what shipped on 2026-04-18; this section logs the corrections.

| Finding | Severity | Where it was | Fix |
|---|---|---|---|
| **F1** — `fanoutInventoryChange()` was missing the ShipStation v2 enqueue, so single-cell `Avail` edits on `/admin/inventory` did not propagate to ShipStation v2. The plan §15.2/§15.3 deferred this via the per-location probe; the audit pulled the SKU-total interim forward because it does not need the probe (writes route to `workspaces.shipstation_v2_inventory_location_id`, the workspace default). | HIGH | `src/lib/server/inventory-fanout.ts` | Added a fourth fanout target after the Bandcamp section: enqueues `shipstation-v2-adjust-on-sku` for every non-zero `recordInventoryChange()` write. Function signature gained a new optional `source?: InventorySource` parameter (propagated from `record-inventory-change.ts`) so the fanout layer can echo-skip `source ∈ {shipstation, reconcile}` (Rule #65 — prevents double-decrement on Clandestine SHIP_NOTIFY and reconcile-loop oscillation). Sales (`bandcamp-sale-poll` enqueuing `shipstation-v2-decrement`) and manual-count (`submitManualInventoryCounts` direct-enqueue) re-use the same correlation_id, so the `external_sync_events` UNIQUE on `(system='shipstation_v2', correlation_id, sku, action)` deduplicates the dual enqueue safely. Result type gained `shipstationV2Enqueued: boolean`. New helper `shouldEchoSkipShipstationV2()` exported for unit testing. Per-location rewrite remains deferred (§15.3 probe + WS3 §3f). |
| **F2** — `fanoutInventoryChange()` docstring promised an `inventory_sync_paused` short-circuit but the body did not implement it. Downstream tasks did short-circuit (so no remote API hit landed), but Trigger.dev still received needless enqueues and the kill switch was not "immediate" the way `§19 Rollback contracts` claimed. | MEDIUM | `src/lib/server/inventory-fanout.ts` | Added a Supabase lookup at the top of the function: if `workspaces.inventory_sync_paused=true`, set Sentry attribute `fanout.skipped='inventory_sync_paused'` and return zeroed `FanoutResult` immediately. Behavior now matches the docstring and §19. |
| **F3** — `shipstation-v2-adjust-on-sku` ignored the global `inventory_sync_paused` flag, gating only on the per-integration `fanout-guard "shipstation"` switch. This meant an operator pausing global inventory sync would still see manual-count entries push to ShipStation v2 unless they also paused the per-integration switch. | MEDIUM | `src/trigger/tasks/shipstation-v2-adjust-on-sku.ts` | Added skip step `(0)` to the cascade: extends the workspaces select to include `inventory_sync_paused`; if true, returns `skipped_inventory_sync_paused`. New status added to the result-type union. Pattern mirrors `bandcamp-inventory-push.ts` and `multi-store-inventory-push.ts`. |
| **F4** — Plan body referenced the old task name `shipstation-v2-sync-on-sku` in ~24 places; the codebase, `TRIGGER_TASK_CATALOG.md`, and `API_CATALOG.md` all use `shipstation-v2-adjust-on-sku` (which handles BOTH directions of delta — see WS2 implementation note). | LOW | `docs/plans/shipstation-source-of-truth-plan.md` | Selective rename in body sections that describe shipped behavior. Historical sections (§3f / §15.3 / §15.6) preserve the old name where they describe the deferred per-location rewrite that may legitimately use a new task name when it ships. |
| **F5** — Plan body referenced "migration 50" / `20260413000050_phase4b_shipstation_fanout.sql`; reality shipped as `20260418000001_phase4b_megaplan_closeout_and_count_session.sql` (single migration that bundled WS1 + WS3 schema). | LOW | `docs/plans/shipstation-source-of-truth-plan.md` | Updated migration filename references to match what shipped. The original migration filename is a documented `Deviation from plan` already; F5 propagates that downstream. |

Verification gates after the F1–F5 fixes:

- `pnpm typecheck` — green
- `pnpm vitest run` — 112 files / **1097 tests** passing (1084 → 1097 means 13 new tests landed across `inventory-fanout.test.ts` for the echo-skip + pause-skip + result-shape coverage)
- `pnpm check:fix` — clean (1 file auto-formatted; 25 pre-existing warnings + 5 infos unaffected)

Doc-sync contract (Rule: PLAN/BUILD/AUDIT prompt-pack `Doc Sync Contract`) updates that landed with the fixes:

- `docs/system_map/TRIGGER_TASK_CATALOG.md` — `shipstation-v2-adjust-on-sku` row now lists `fanoutInventoryChange()` as a second invoker and includes step `(0)` in the skip cascade
- `docs/system_map/API_CATALOG.md` — `submitManualInventoryCounts` fanout note now mentions the dual-enqueue + ledger dedup contract and the `inventory_sync_paused` gate at both layers
- `project_state/journeys.yaml` — `per_integration_kill_switches_and_rollouts` checks now mention F1 wiring, F2 fanout-entry pause, and the Rule #65 echo-cancellation
- `docs/DEFERRED_FOLLOWUPS.md` — `ws3-3f-per-location-rewrite` context updated to note the SKU-total path now ships; severity downgraded `high → medium` because the operational-blocker portion is resolved (only the per-location optimization remains gated)
- `CLAUDE.md` — no rule edits needed; F1 follows existing Rules #20 (single write path), #43 (event ordering), #59 (bulk-sync exception), #65 (echo cancellation), #67 (connection pooling)

Net effect: as of 2026-04-13, FR-1 from §12 is fully closed for the SKU-total semantic. A staff member editing the `Avail` cell on `/admin/inventory` now sees ShipStation v2 update within seconds via the `shipstation-v2-adjust-on-sku` task, ledger-gated and concurrency-safe through the shared `shipstation` queue. Per-location rewrite (§3f) remains the only deferred item and is unchanged in scope.

## Implementation notes

These notes capture the build-time decisions that aren't already obvious from the code or from §15 of the plan.

- **WS1 migration deliberately pre-shipped WS3 schema.** `supabase/migrations/20260418000001_phase4b_megaplan_closeout_and_count_session.sql` ships the spot-check table + sampler RPC + count-session columns on `warehouse_inventory_levels` (`count_status`, `count_started_at`, `count_started_by`, `count_baseline_available`, `has_per_location_data`) + ShipStation v2 location mirror columns on `warehouse_locations` (`shipstation_inventory_location_id`, `shipstation_synced_at`, `shipstation_sync_error`) + extends `warehouse_inventory_activity_source_check` to include `'cycle_count'` and `'manual_inventory_count'`. Reason: the sampler RPC (`megaplan_sample_skus_per_client`) calls `coalesce(count_status,'idle')` in its WHERE clause, so the column has to exist at function compile time. Side benefit: WS3 sub-tasks ship with **no new SQL** at all, which kept the §15.3 probe gate from blocking schema work.
- **`InventorySource` type union had to be widened in WS2.** The WS1 migration extended `warehouse_inventory_activity_source_check` to admit `'cycle_count'` and `'manual_inventory_count'`, but `src/lib/shared/types.ts` was not updated in the same pass. WS2 caught this — the type union now includes both new sources so WS3's `recordInventoryChange({ source:'cycle_count' })` and WS2's `recordInventoryChange({ source:'manual_inventory_count' })` both type-check.
- **WS2 needed a new ShipStation v2 task — generic fanout doesn't carry v2.** `fanoutInventoryChange()` handles Bandcamp + Clandestine Shopify + client-store fanout but does NOT enqueue ShipStation v2 (Phase 4 design intentionally kept v2 fanout direct via `shipstation-v2-decrement` for sales). Manual counts can move inventory in BOTH directions, so WS2 added `shipstation-v2-adjust-on-sku` as a sibling task that selects `transaction_type:'increment'` or `'decrement'` based on delta sign — never `modify` (Phase 0 Patch D2). Same skip cascade as the decrement task; ledger-keyed `(system='shipstation_v2', correlation_id, sku, action='increment'|'decrement')`. Failure to enqueue is logged but non-fatal — Phase 5 reconcile sensor is the backstop.
- **WS3 `completeCountSession` re-reads current `available` (v4 hardening, NOT v3).** Per the §17.1 v4 hardening table and the Scenario A defense in §15.6: a sale that lands mid-count is already reflected in `warehouse_inventory_levels.available`, so summing `warehouse_variant_locations.quantity_available` and diffing against the *current* available correctly yields delta=0 (count POST-sale). Diffing against `count_baseline_available` (the v3 formula) would have written a bogus negative delta. `count_baseline_available` is retained as audit metadata only — it is never used in delta math.
- **WS3 sets `has_per_location_data=true` on first per-location write.** This sticky flag is the pivot key for the deferred WS3 §3f rewrite of `shipstation-v2-sync-on-sku`. Until the §15.3 probe outcome is known, it's a no-op flag — the existing SKU-level v2 path runs for everyone. Once the rewrite ships, SKUs with `has_per_location_data=true` route per-location; SKUs without it stay on the SKU-total path. R-23 oscillation prevention.
- **WS3 `updateLocation` calls ShipStation FIRST on rename (v4 hardening).** If v2 fails, the local `warehouse_locations.name` stays unchanged so the operator can retry against truth. The reverse order (local first, then v2) would have produced a state where local truth diverges from ShipStation and a retry has nothing to retry from.
- **WS3 `createLocationRange` enforces Rule #41 with a 30-entry inline cap.** ≤30 entries: inline loop with 300 ms throttling (~12 s budget for the 60 s Server Action ceiling). >30 entries: offload to the new `bulk-create-locations` Trigger task (pinned to `shipstation` queue, `maxDuration: 600`, partial mirror failures surface as one `warehouse_review_queue` row at exit). Throttle is 300 ms — bumped from 250 ms during v5 review for safety margin against the shared 200 req/min v2 rate bucket.
- **WS3 ShipStation 409 conflicts on `createInventoryLocation` are resolved by `listInventoryLocations`.** A 409 means the location name already exists in ShipStation (e.g. left over from a prior import or operator action). Treating it as a hard error would break operator flow; instead, the action calls `listInventoryLocations`, finds the existing row by name, and stores its id in `shipstation_inventory_location_id`. R-22 fix.
- **WS3 inventory-page UI is a single panel mounted in the existing expanded-row detail.** No new top-level page was created in this workstream — the panel (`src/components/admin/inventory-count-session-panel.tsx`) sits above the existing Locations / Recent Activity 2-col grid. This was the intentional build-day swap of `full_redesign` → `add_panel_to_existing_row` to keep WS3 within the day.
- **Two test-file biome ignores added.** `tests/unit/actions/inventory-counts.test.ts` and `tests/unit/actions/locations.test.ts` mock the Supabase query builder, which is intentionally a thenable-with-methods. Biome's `lint/suspicious/noThenProperty` flagged the `then` property; targeted `// biome-ignore lint/suspicious/noThenProperty` comments were added at the three call sites. No production code uses the pattern.

## Deviations from plan

| Deviation | Plan section | Why |
|---|---|---|
| WS3 §3c shipped as a **panel mounted into the existing inventory expanded-row detail**, not as a re-design of the whole inventory page | §15.6 / §27 | Kept Saturday inside the budget. The panel covers Tue/Wed onboarding fully. The richer page-level UX polish moved to Sunday per the original `split_to_sunday` decision. |
| WS3 §3g (standalone `/admin/inventory/locations` page) **deferred to Sunday** | §15.6 / §27 | Inline create from the count UI's locator typeahead covers Tuesday onboarding without it. Sunday picks it up with the rest of the UX polish pass. |
| WS3 §3f (per-location rewrite of `shipstation-v2-sync-on-sku` + `fanoutInventoryChange` v2 enqueue) **deferred until §15.3 probe outcome** | §15.3 GATE | This is the explicit `stop_at_3d` choice the operator made on build day. The probe runs Saturday morning; results determine whether the rewrite is safe to ship at all. Until then, writes route through the existing SKU-level v2 path. |
| WS1 migration ships **count-session + location-mirror schema** rather than splitting it into a WS3 migration | §15.2 | The sampler RPC for spot-check references `count_status`, so the column had to exist at the same migration as the RPC. Bundling it with the location mirror columns was the lowest-risk path — one migration, one apply, no inter-workstream ordering concern. |
| WS2 added **`shipstation-v2-adjust-on-sku`** Trigger task that wasn't in the original §15 design | §15 (manual count) | Manual counts can adjust inventory in BOTH directions; the existing `shipstation-v2-decrement` is sale-only / decrement-only. The new sibling task uses the same queue, ledger, and skip cascade — design parity preserved. |
| `InventorySource` type union widened in WS2 (post-WS1) | §15.2 | The WS1 migration widened the DB constraint but the TS union was missed. Caught early in WS2; both `'cycle_count'` and `'manual_inventory_count'` added in one edit. |
| Two test files needed targeted biome ignores | §18 | Supabase client query builder is an intentional thenable; biome's `noThenProperty` rule fired on the test mocks. Production code is untouched. |

No silent functional deviations. Every deviation above is either a build-day operator choice (`stop_at_3d`, `split_to_sunday`) or a small implementation discovery the plan text didn't anticipate.

## Final files changed

**WS1 — Mega-plan closeout (Phase 6)**

New files:
- `src/trigger/tasks/megaplan-spot-check.ts`
- `src/trigger/tasks/deferred-followups-reminder.ts`
- `src/actions/megaplan-spot-check.ts`
- `src/app/admin/settings/megaplan-verification/page.tsx`
- `docs/DEFERRED_FOLLOWUPS.md`
- `docs/MEGA_PLAN_VERIFICATION_2026-04-13.md`
- `supabase/migrations/20260418000001_phase4b_megaplan_closeout_and_count_session.sql` (combined WS1 + WS3 schema — pre-ships count-session columns and v2 location mirror columns; extends source check to include `cycle_count` + `manual_inventory_count`)

Modified files:
- `src/components/admin/admin-sidebar.tsx` (Mega-plan verification SETTINGS_ITEMS entry)
- `trigger.config.ts` (`additionalFiles` extension to bundle `docs/DEFERRED_FOLLOWUPS.md` into the Trigger build)
- `src/trigger/tasks/index.ts` (registry exports for both new tasks)

**WS2 — Manual inventory count entry**

New files:
- `src/actions/manual-inventory-count.ts`
- `src/trigger/tasks/shipstation-v2-adjust-on-sku.ts`
- `src/app/admin/inventory/manual-count/page.tsx`
- `tests/unit/actions/manual-inventory-count.test.ts`

Modified files:
- `src/lib/shared/types.ts` (`InventorySource` union: added `'manual_inventory_count'` and `'cycle_count'`)
- `src/components/admin/admin-sidebar.tsx` (Manual Count NAV_ITEMS entry under Inventory)
- `src/trigger/tasks/index.ts` (registry export for `shipstationV2AdjustOnSkuTask`)

**WS3 — Count sessions + locations source-of-truth (3a → 3d)**

New files:
- `src/actions/inventory-counts.ts`
- `src/actions/locations.ts`
- `src/trigger/tasks/bulk-create-locations.ts`
- `src/components/admin/inventory-count-session-panel.tsx`
- `tests/unit/actions/inventory-counts.test.ts`
- `tests/unit/actions/locations.test.ts`
- `tests/unit/lib/clients/shipstation-inventory-v2.test.ts` (extended for the three new client functions)

Modified files:
- `src/lib/clients/shipstation-inventory-v2.ts` (added `createInventoryLocation` / `updateInventoryLocation` / `deleteInventoryLocation`)
- `src/app/admin/inventory/page.tsx` (mounts `InventoryCountSessionPanel` in the expanded-row detail)
- `src/trigger/tasks/index.ts` (registry export for `bulkCreateLocationsTask`)

**Doc sync (all three workstreams)**

Modified:
- `docs/system_map/API_CATALOG.md` (Manual count + Count sessions + Locations + Mega-plan verification entries)
- `docs/system_map/TRIGGER_TASK_CATALOG.md` (`megaplan-spot-check`, `deferred-followups-reminder`, `shipstation-v2-adjust-on-sku`, `bulk-create-locations`)
- `project_state/engineering_map.yaml` (WS1, WS2, WS3 owner lines under `inventory_engine`)
- `project_state/journeys.yaml` (`megaplan_verification`, `manual_inventory_count_entry`, `inventory_count_session`, `warehouse_locations_source_of_truth`)
- `TRUTH_LAYER.md` (WS1, WS2, WS3 closeout paragraphs)
- `CLAUDE.md` (Rule #75 manual counts, Rule #76 count sessions, Rule #77 locations source-of-truth)

## Follow-up tasks

| Task | Owner trigger | Resume contract |
|---|---|---|
| WS3 §15.3 GATE — ShipStation v2 per-location semantics probe | operator runs Saturday morning per §15.3 (3-case probe — single-location SKU, multi-location SKU, location with no inventory) | Operator reports outcome. If probe shows v2 honors per-location writes consistently → proceed with §3f. If not → pivot to the §15.6 fallback (continue routing through SKU-total v2 path indefinitely; mark `has_per_location_data` as audit-only). |
| WS3 §3f — Per-location rewrite of `shipstation-v2-sync-on-sku` + `fanoutInventoryChange` v2 enqueue | unblocked by §15.3 probe outcome above | Pivot key: `warehouse_inventory_levels.has_per_location_data`. SKUs at `true` route per-location; SKUs at `false` stay on SKU-total. R-23 oscillation prevention is already baked into the sticky-flag design. |
| WS3 §3g — Standalone `/admin/inventory/locations` admin page | Sunday UX polish pass | Lists all `warehouse_locations` with filter/search, surfaces `shipstation_sync_error` rows with a Retry button (calls `retryShipstationLocationSync`), supports bulk creation via the existing `createLocationRange` action (which already auto-routes to the `bulk-create-locations` Trigger task for >30 entries). |
| Sunday UX polish (carried forward from §28) | Sunday | Per-row count-session indicators on the inventory list (without expanding the row) — **DONE in the post-closeout 1hr sprint on 2026-04-18** (`/admin/inventory` shows an amber "Counting…" badge with "Xm ago by NAME" subline on any row whose `count_status='count_in_progress'`; `getInventoryLevels` extended with embedded `users:count_started_by(id,name)` join; `getClientInventoryLevels` hard-nulls the new fields so staff workflow state never leaks to clients; companion test updated). Remaining: bulk Avail edit shortcut, and the standalone Locations page above. |
| UX dry-run #1 — Sunday ~10:00 (per §31) | Sunday | Part A: edit Avail cell, observe Bandcamp + ShipStation update within 60 s. Part B: start a count session, observe NEITHER Bandcamp NOR ShipStation update during the in-progress phase. Both must pass before ramping to 10%. |
| WS3 §15.3 fallback documentation | only if probe fails | Update §15.6 + add a deferred-followups entry capturing the long-term decision. |

## Deferred items (updated)

This is the live state of the deferred-followups registry as of build close. The full source of truth is `docs/DEFERRED_FOLLOWUPS.md` (parsed daily by the `deferred-followups-reminder` cron); §22 above is the original plan-time table.

Already in the registry from earlier in the plan:
- `phase-7-dormant-cleanup` (2026-07-13, medium)
- `tier1-9-better-stack` (2026-05-13, high)
- `tier1-10-statuspage` (2026-05-13, high)
- `external-sync-events-retention` (2026-04-25, low)
- `shipstation-stale-location-cleanup` (2026-04-23, medium)
- `inventory-locator-bidirectional-sync` (TBD, low)
- `wake-lock-and-sessionstorage` (TBD, medium)
- `fanout-guard-sku-deterministic` (2026-05-13, medium)
- `per-bin-sale-routing` (2026-07-13, medium)
- `migration-ordering-from-scratch` (2026-05-15, low)
- `shared-utils-path` (2026-05-15, low)
- `role-matrix-rename` (2026-05-15, low)
- `scanning-auth-audit` (2026-06-01, medium)

**New deferrals from build close (added to `docs/DEFERRED_FOLLOWUPS.md` as part of this closeout):**

| Slug | Title | Due | Severity | Status |
|---|---|---|---|---|
| `ws3-3f-per-location-rewrite` | WS3 §3f — Per-location rewrite of `shipstation-v2-sync-on-sku` + `fanoutInventoryChange` v2 enqueue. Gated by §15.3 probe; `has_per_location_data` is the pivot key. | 2026-04-22 (operator deadline — review probe outcome and decide ship/skip) | high | open (gated) |
| `ws3-3g-locations-admin-page` | WS3 §3g — Standalone `/admin/inventory/locations` admin page. Inline create from the count panel covers Tue/Wed; this is for bulk operator workflows + sync-error retry surface. | 2026-04-19 (Sunday UX pass) | medium | **DONE 2026-04-18** (1hr sprint #2 post-closeout — see v9 below) |
| `ws3-ux-polish-sunday` | Per-row count indicators on the inventory list, bulk Avail edit shortcut, locations admin page (above) — bundled Sunday UX polish from §28. | 2026-04-19 | medium | items (1) + (3) DONE 2026-04-18; only (2) bulk Avail edit remains |
| `ws3-ux-dry-run-1` | UX dry-run #1 (Sunday ~10:00 per §31) — Part A Avail-edit fanout latency, Part B count-session fanout suppression. Both must pass before ramping to 10%. | 2026-04-19 | high | open |

## Known limitations

These are conscious limitations of what shipped — not bugs. Each is either accepted-for-now with a deferred-followups slug or compensating-controlled.

- **Per-location ShipStation v2 fanout is not live yet.** Until §15.3 probe outcome is in and §3f ships, all v2 writes route through the SKU-total path. The `has_per_location_data` flag is set but unused. Compensating control: Phase 5 reconcile sensor is the backstop; staff can fix any cross-location drift via the existing reconcile-on-SKU surface.
- **Standalone `/admin/inventory/locations` page does not exist yet.** Operators add new locations through the count panel's locator typeahead during a count session. For Tuesday onboarding this is sufficient (operator labels a shelf, expands the SKU it goes on, types the new location name into the typeahead, hits Create). For bulk pre-onboarding location creation, `createLocationRange` is callable but has no UI surface — the operator runs it from a dev console or via a temporary script. Sunday UX polish closes this.
- **Locations sync is one-way (our app → ShipStation).** ShipStation → our-app sync is not wired. If an operator creates a location directly in ShipStation, it is invisible to our app. Compensating control: `docs/DEFERRED_FOLLOWUPS.md` `inventory-locator-bidirectional-sync` (TBD, low) tracks the long-term plan.
- **`completeCountSession` does not lock `available` during its read-sum-write sequence.** A sale could land between `currentAvailable` re-read and `recordInventoryChange()` apply, producing a microsecond skew. The compensating control is that `recordInventoryChange` itself is the single write path (Rule #20) and any Redis/Postgres skew is caught by the Phase 5 reconcile sensor. The true fix is absolute-set-in-RPC inside `record_inventory_change_txn`, deferred — see review pass v5 reviewer 1 §2.
- **`bulk-create-locations` partial-failure surfacing is one queue item per task run, not per failed location.** If 200 locations are bulk-created and 17 fail their v2 mirror, operators get one review-queue row with a per-row failure summary in metadata, not 17 rows. This was the conscious choice — 17 separate queue items would be noise. Operators retry via `retryShipstationLocationSync` per row.
- **`deactivateLocation` blocks on any non-zero `quantity_available` reference.** There's no force-deactivate or move-then-deactivate flow. Operators must zero out the location (via a count session) before deactivating. Acceptable for Tuesday — staff are entering counts, not rebalancing existing inventory.
- **Inventory-count panel is desktop-first.** It works on a phone/tablet but the locator typeahead is mouse-optimized. Scanner hardware support (Rule #50 wake lock + sessionStorage) is deferred — see `wake-lock-and-sessionstorage` (TBD, medium).
- **No automated lint/CI guard against direct `warehouse_inventory_levels.available` writes from the count session.** The discipline is enforced by code review and Rule #20 (single write path), but Rule #42 ("Inventory Write-Path Enforcement") was not extended in this plan to grep for the new sources. The companion test for `inventory-counts.ts` covers the happy path; the negative case (someone bypasses `recordInventoryChange`) would still slip through CI today.

## What we learned

These are the build-time observations worth carrying into the next plan.

- **Pre-shipping schema for a downstream workstream in an upstream workstream's migration is high-leverage when there's a non-obvious compile-time dependency.** The sampler RPC's `coalesce(count_status,'idle')` filter forced `count_status` into the WS1 migration. Bundling the rest of the count-session columns + the v2 location mirror columns into the same migration cost ~5 minutes and saved WS3 from doing any SQL at all. Pattern: when WS_N+1's schema is a stable design, ship it with WS_N. (Tradeoff: WS_N+1 is then committed to that schema even if its design later wants to change. We accepted this here because the schema is small and bounded.)
- **"Sibling task" beats "extend existing task" when the existing task has a narrow contract.** WS2 needed bidirectional ShipStation v2 adjustment; `shipstation-v2-decrement` is sale-only / decrement-only. Trying to widen it would have leaked manual-count semantics into the sale path. The sibling task pattern (`shipstation-v2-adjust-on-sku`) re-uses queue, ledger, skip cascade, and external-sync-events shape but stays type-narrow. Same pattern applied to `bulk-create-locations` vs inline `createLocation`.
- **`completeCountSession`'s "diff against current available, NOT baseline" decision was the highest-stakes single design choice in the plan.** v3 had `delta = sum - baseline`, which Scenario A inverts to over-decrement. v4 caught it (`delta = sum - current_available`). Build-day implementation matched v4. This is worth pinning as a design-pattern guideline: when computing a delta from a stale snapshot vs a live state, ALWAYS diff against the live state and treat the snapshot as audit metadata.
- **A "stop at 3d" gate is a perfectly valid build outcome.** The §15.3 probe gate would have been ignored under build pressure if it weren't formalized in the plan and surfaced as a build-day decision (`AskQuestion` + `stop_at_3d`). Plans that include explicit halt-here-pending-evidence checkpoints are more honest than plans that pretend everything ships in one day.
- **Two-file biome ignore for an intentional Supabase thenable mock is fine; the alternative (rewrite the mock to avoid `then`) doubles test complexity.** Targeted `// biome-ignore lint/suspicious/noThenProperty` comments are the right call when the rule is correct in general but the mock is intentionally implementing Promise interop.
- **The expanded-row detail is undervalued real estate.** The plan originally implied a richer Locations admin page would land Tuesday. The build-day pivot to "mount a panel in the existing expanded-row detail" gave operators the same workflow with ~30% of the code. The standalone page is now Sunday's polish job rather than Saturday's blocker.
- **Doc-sync-as-you-go beats doc-sync-at-end.** Each workstream landed with its `API_CATALOG.md` + `TRIGGER_TASK_CATALOG.md` + `engineering_map.yaml` + `journeys.yaml` + `TRUTH_LAYER.md` + `CLAUDE.md` updates in the same commit window. By close of WS3, there was zero doc backlog. Compare to WS1 where the same docs were updated in a separate pass — the in-stream pattern is faster and lower-error.
- **`InventorySource` union → DB check-constraint synchronization should be a build-time invariant, not a "remember to update both."** WS2 caught the missing union widening because typecheck failed. A small future hardening: a script that diffs the TS union against the DB check-constraint and fails CI on drift. Not in scope for this plan; worth a deferred-followup if it bites again.

---

# Appendix A — Assumptions (consolidated and indexed)

This is the same numbered set as §16, reorganized by category for cross-referencing during review.

### A.1. Database / schema assumptions

- A-7 — `warehouse_locations.workspace_id` is set on every existing row.
- A-8 — `warehouse_variant_locations` exists with `(variant_id, location_id, quantity, updated_at)` columns.
- A-9 — `warehouse_inventory_levels` is keyed by `(workspace_id, variant_id)`.
- A-10 — `derive_inventory_org_id` trigger fires on UPDATE as well as INSERT.
- A-11 — Adding three columns to `warehouse_inventory_levels` does not break the Phase 5 `sku_sync_status` view.

### A.2. External API assumptions

- A-2 — `POST /v2/inventory_locations` accepts `{ inventory_warehouse_id, name }` and returns `{ inventory_location_id, name, ... }`.
- A-3 — `PUT /v2/inventory_locations/{id}` accepts `{ name }` for renames.
- A-4 — `DELETE /v2/inventory_locations/{id}` is idempotent.
- A-5 — `POST /v2/inventory` with `transaction_type: 'modify' new_available: 0` returns 400.
- A-6 — Per-location `modify new_available: N` writes do NOT cause ShipStation to recompute SKU total; ShipStation manages this internally because each location is a separate inventory record. **Highest-stakes assumption — Sat eve dry-run before deploy.**

### A.3. Configuration assumptions

- A-1 — `fanout_rollout_percent = 0` for all workspaces today.
- A-14 — `SHIPSTATION_V2_API_KEY` is configured in production.
- A-15 — `workspaces.shipstation_v2_inventory_warehouse_id` is configured for the Clandestine workspace.
- A-19 — `pnpm`, `supabase`, `git` are auto-allowed in the operator's Cursor session.

### A.4. Tooling and codebase assumptions

- A-12 — `pnpm release:gate` exists and includes typecheck + test + build + biome + write-path lint.
- A-13 — Trigger.dev v4 `tasks.trigger()` is the supported enqueue API.
- A-16 — `bandcamp-push-on-sku` math semantics are preserved by `shipstation-v2-sync-on-sku`.
- A-20 — `useAppQuery` and `useAppMutation` hooks exist with the expected signatures.
- A-21 — `sonner` toast library is installed (or fallback to inline status banner).

### A.5. Operational / scheduling assumptions

- A-17 — Operator UX dry runs Sun 10:00 and Mon 14:00 are calendared.
- A-18 — Tue Apr 21 09:00 staff training is non-rescheduleable.

---

# Appendix B — Existing code source (inlined verbatim for the 8 critical files this plan extends)

Each file is reproduced exactly as it exists at this writing. Reviewers can use these as the baseline against which to evaluate the proposed patches in Appendix C.

## B.1. `src/lib/server/inventory-fanout.ts`

```typescript
/**
 * Inventory fanout — Rule #43 step (4).
 *
 * Called after recordInventoryChange succeeds.
 * Pushes inventory changes to all downstream systems:
 * - Clandestine Shopify (direct API, not client_store_connections)
 * - Bandcamp (via bandcamp-inventory-push task)
 * - Client stores (via multi-store-inventory-push task)
 *
 * When workspaces.inventory_sync_paused is true, all outbound pushes are
 * skipped immediately. recordInventoryChange() still completes — Redis + Postgres
 * stay current. The updated quantities are pushed when sync resumes.
 */

import * as Sentry from "@sentry/nextjs";
import { tasks } from "@trigger.dev/sdk";
import { inventoryAdjustQuantities } from "@/lib/clients/shopify-client";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const SHOPIFY_LOCATION_ID = "gid://shopify/Location/104066613563";

export interface FanoutResult {
  storeConnectionsPushed: number;
  bandcampPushed: boolean;
  shopifyPushed: boolean;
}

export function determineFanoutTargets(
  hasStoreConnections: boolean,
  hasBandcampMapping: boolean,
): { pushToStores: boolean; pushToBandcamp: boolean } {
  return {
    pushToStores: hasStoreConnections,
    pushToBandcamp: hasBandcampMapping,
  };
}

export async function fanoutInventoryChange(
  workspaceId: string,
  sku: string,
  _newQuantity: number,
  delta?: number,
  correlationId?: string,
): Promise<FanoutResult> {
  return Sentry.startSpan(
    {
      name: "inventory.fanout",
      op: "fanout.dispatch",
      attributes: {
        "fanout.workspace_id": workspaceId,
        "fanout.sku": sku,
        "fanout.delta": delta ?? 0,
        "fanout.correlation_id": correlationId ?? "",
      },
    },
    async () => {
      const supabase = createServiceRoleClient();
      const guard = await loadFanoutGuard(supabase, workspaceId);
      const effectiveCorrelationId = correlationId ?? `fanout:${sku}:${Date.now()}`;

      let storeConnectionsPushed = 0;
      let bandcampPushed = false;
      let shopifyPushed = false;

      const { data: variant } = await supabase
        .from("warehouse_product_variants")
        .select("id, shopify_inventory_item_id")
        .eq("workspace_id", workspaceId)
        .eq("sku", sku)
        .single();

      if (
        variant?.shopify_inventory_item_id &&
        delta != null &&
        delta !== 0 &&
        guard.shouldFanout("clandestine_shopify", effectiveCorrelationId)
      ) {
        try {
          await Sentry.startSpan(
            {
              name: "inventory.fanout.shopify",
              op: "fanout.shopify",
              attributes: { "fanout.sku": sku, "fanout.delta": delta },
            },
            () =>
              inventoryAdjustQuantities(
                variant.shopify_inventory_item_id as string,
                SHOPIFY_LOCATION_ID,
                delta,
                effectiveCorrelationId,
              ),
          );
          shopifyPushed = true;
        } catch (err) {
          Sentry.captureException(err, {
            tags: { fanout_target: "clandestine_shopify", sku },
            extra: { workspaceId, correlationId: effectiveCorrelationId },
          });
          console.error(
            `[fanout] Shopify push failed for SKU=${sku}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      const { data: skuMappings } = await supabase
        .from("client_store_sku_mappings")
        .select("connection_id")
        .eq("is_active", true)
        .eq("remote_sku", sku);

      const { data: bandcampMappings } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, variant_id")
        .eq("workspace_id", workspaceId);

      const hasBandcampMapping =
        variant &&
        (bandcampMappings ?? []).some(
          (m) => (m as Record<string, unknown>).variant_id === variant.id,
        );

      const targets = determineFanoutTargets((skuMappings ?? []).length > 0, !!hasBandcampMapping);

      if (targets.pushToStores && guard.shouldFanout("client_store", effectiveCorrelationId)) {
        try {
          await tasks.trigger("multi-store-inventory-push", {});
          storeConnectionsPushed = (skuMappings ?? []).length;
        } catch {
          /* non-critical */
        }
      }

      if (targets.pushToBandcamp && guard.shouldFanout("bandcamp", effectiveCorrelationId)) {
        try {
          await tasks.trigger("bandcamp-inventory-push", {});
          bandcampPushed = true;
        } catch {
          /* non-critical */
        }
      }

      if (variant) {
        const { data: parentBundles } = await supabase
          .from("bundle_components")
          .select("bundle_variant_id")
          .eq("workspace_id", workspaceId)
          .eq("component_variant_id", variant.id)
          .limit(1);

        if (parentBundles?.length) {
          if (!targets.pushToBandcamp && guard.shouldFanout("bandcamp", effectiveCorrelationId)) {
            try {
              await tasks.trigger("bandcamp-inventory-push", {});
            } catch {
              /* */
            }
          }
          if (!targets.pushToStores && guard.shouldFanout("client_store", effectiveCorrelationId)) {
            try {
              await tasks.trigger("multi-store-inventory-push", {});
            } catch {
              /* */
            }
          }
        }
      }

      return { storeConnectionsPushed, bandcampPushed, shopifyPushed };
    },
  );
}
```

## B.2. `src/lib/server/record-inventory-change.ts`

```typescript
import { adjustInventory } from "@/lib/clients/redis-inventory";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { InventorySource } from "@/lib/shared/types";

interface RecordInventoryChangeParams {
  workspaceId: string;
  sku: string;
  delta: number;
  source: InventorySource;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

interface RecordInventoryChangeResult {
  success: boolean;
  newQuantity: number | null;
  alreadyProcessed: boolean;
}

/**
 * Rule #20: Single inventory write path. ALL inventory changes flow through this function.
 * No code path may directly mutate warehouse_inventory_levels or Redis inv:* keys outside this function.
 *
 * Rule #43 execution order:
 * (1) acquire correlationId (passed in)
 * (2) Redis HINCRBY via adjustInventory with SETNX guard (Rule #47)
 * (3) Postgres RPC record_inventory_change_txn in single transaction (Rule #64)
 * (4) enqueue fanout (non-blocking)
 *
 * If step 3 fails after step 2, Redis is rolled back immediately via a compensating
 * adjustInventory call with a :rollback correlation ID. The sensor-check auto-heal
 * (every 5 min) is a secondary safety net, not the primary recovery mechanism.
 */
export async function recordInventoryChange(
  params: RecordInventoryChangeParams,
): Promise<RecordInventoryChangeResult> {
  const { workspaceId, sku, delta, source, correlationId, metadata } = params;

  const redisResult = await adjustInventory(sku, "available", delta, correlationId);

  if (redisResult === null) {
    return { success: true, newQuantity: null, alreadyProcessed: true };
  }

  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase.rpc("record_inventory_change_txn", {
      p_workspace_id: workspaceId,
      p_sku: sku,
      p_delta: delta,
      p_source: source,
      p_correlation_id: correlationId,
      p_metadata: metadata ?? {},
    });

    if (error) throw error;
  } catch (err) {
    try {
      await adjustInventory(sku, "available", -delta, `${correlationId}:rollback`);
    } catch (rollbackErr) {
      console.error(
        `[recordInventoryChange] CRITICAL: Redis rollback also failed. ` +
          `SKU=${sku} delta=${delta} correlationId=${correlationId}`,
        rollbackErr,
      );
    }
    console.error(
      `[recordInventoryChange] Postgres failed, Redis rolled back. ` +
        `SKU=${sku} delta=${delta} correlationId=${correlationId}`,
      err,
    );
    return { success: false, newQuantity: null, alreadyProcessed: false };
  }

  try {
    const { fanoutInventoryChange } = await import("@/lib/server/inventory-fanout");
    fanoutInventoryChange(workspaceId, sku, redisResult, delta, correlationId).catch((err) => {
      console.error(`[recordInventoryChange] Fanout failed for SKU=${sku}:`, err);
    });
  } catch {
    // Fanout is non-critical — cron jobs will pick up changes
  }

  return { success: true, newQuantity: redisResult, alreadyProcessed: false };
}
```

## B.3. `src/lib/server/external-sync-events.ts`

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * `external_sync_events` ledger helper (plan §1.4.2).
 *
 * Every external mutation (ShipStation v2 inventory ops, Bandcamp
 * `update_quantities` / `update_sku`, ShipStation v1 alias add/remove,
 * Clandestine Shopify SKU rename) MUST flow through this helper. The
 * UNIQUE (system, correlation_id, sku, action) constraint provides
 * idempotency: a duplicate retry collides on insert and the caller learns
 * the operation is already in flight or completed.
 */

export type ExternalSyncSystem =
  | "shipstation_v1"
  | "shipstation_v2"
  | "bandcamp"
  | "clandestine_shopify";

export type ExternalSyncAction =
  | "increment"
  | "decrement"
  | "adjust"
  | "modify"
  | "alias_add"
  | "alias_remove"
  | "sku_rename";

export interface BeginExternalSyncInput {
  system: ExternalSyncSystem;
  correlation_id: string;
  sku: string;
  action: ExternalSyncAction;
  request_body?: unknown;
}

export type BeginExternalSyncResult =
  | { acquired: true; id: string }
  | {
      acquired: false;
      reason: "already_in_flight" | "already_succeeded" | "already_errored";
      existing_id: string;
      existing_status: "in_flight" | "success" | "error";
    };

export async function beginExternalSync(
  supabase: SupabaseClient,
  input: BeginExternalSyncInput,
): Promise<BeginExternalSyncResult> {
  const { data, error } = await supabase
    .from("external_sync_events")
    .insert({
      system: input.system,
      correlation_id: input.correlation_id,
      sku: input.sku,
      action: input.action,
      status: "in_flight",
      request_body: input.request_body ?? null,
    })
    .select("id")
    .single();

  if (!error && data) return { acquired: true, id: data.id };
  if (error.code !== "23505") throw error;

  const { data: existing, error: lookupError } = await supabase
    .from("external_sync_events")
    .select("id,status")
    .eq("system", input.system)
    .eq("correlation_id", input.correlation_id)
    .eq("sku", input.sku)
    .eq("action", input.action)
    .single();

  if (lookupError || !existing) {
    throw lookupError ?? new Error("external_sync_events conflict but row not found");
  }

  const reasonMap = {
    in_flight: "already_in_flight",
    success: "already_succeeded",
    error: "already_errored",
  } as const;

  return {
    acquired: false,
    reason: reasonMap[existing.status as keyof typeof reasonMap],
    existing_id: existing.id,
    existing_status: existing.status,
  };
}

export async function markExternalSyncSuccess(
  supabase: SupabaseClient,
  id: string,
  response_body?: unknown,
): Promise<void> {
  const { error } = await supabase
    .from("external_sync_events")
    .update({
      status: "success",
      completed_at: new Date().toISOString(),
      response_body: response_body ?? null,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function markExternalSyncError(
  supabase: SupabaseClient,
  id: string,
  err: unknown,
  response_body?: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const { error } = await supabase
    .from("external_sync_events")
    .update({
      status: "error",
      completed_at: new Date().toISOString(),
      response_body: response_body ?? { message },
    })
    .eq("id", id);
  if (error) throw error;
}
```

## B.4. `src/lib/server/fanout-guard.ts`

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntegrationKillSwitchKey } from "@/lib/shared/types";

interface WorkspaceGuardRow {
  shipstation_sync_paused: boolean;
  bandcamp_sync_paused: boolean;
  clandestine_shopify_sync_paused: boolean;
  client_store_sync_paused: boolean;
  inventory_sync_paused: boolean;
  fanout_rollout_percent: number;
}

const FANOUT_GUARD_COLUMNS =
  "shipstation_sync_paused, bandcamp_sync_paused, clandestine_shopify_sync_paused, client_store_sync_paused, inventory_sync_paused, fanout_rollout_percent" as const;

export type FanoutGuardSkipReason = "global_paused" | "integration_paused" | "rollout_excluded";

export interface FanoutGuard {
  readonly row: WorkspaceGuardRow;
  shouldFanout(integration: IntegrationKillSwitchKey, correlationId: string): boolean;
  evaluate(
    integration: IntegrationKillSwitchKey,
    correlationId: string,
  ): { allow: true } | { allow: false; reason: FanoutGuardSkipReason };
}

const PAUSE_COLUMN: Record<IntegrationKillSwitchKey, keyof WorkspaceGuardRow> = {
  shipstation: "shipstation_sync_paused",
  bandcamp: "bandcamp_sync_paused",
  clandestine_shopify: "clandestine_shopify_sync_paused",
  client_store: "client_store_sync_paused",
};

export async function loadFanoutGuard(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<FanoutGuard> {
  const { data, error } = await supabase
    .from("workspaces")
    .select(FANOUT_GUARD_COLUMNS)
    .eq("id", workspaceId)
    .single();

  if (error || !data) {
    return makeGuard({
      shipstation_sync_paused: true,
      bandcamp_sync_paused: true,
      clandestine_shopify_sync_paused: true,
      client_store_sync_paused: true,
      inventory_sync_paused: true,
      fanout_rollout_percent: 0,
    });
  }
  return makeGuard(data as WorkspaceGuardRow);
}

export function makeGuard(row: WorkspaceGuardRow): FanoutGuard {
  return {
    row,
    shouldFanout(integration, correlationId) {
      return this.evaluate(integration, correlationId).allow;
    },
    evaluate(integration, correlationId) {
      if (row.inventory_sync_paused) return { allow: false, reason: "global_paused" };
      const pauseCol = PAUSE_COLUMN[integration];
      if (row[pauseCol]) return { allow: false, reason: "integration_paused" };
      if (!isInRolloutBucket(correlationId, row.fanout_rollout_percent)) {
        return { allow: false, reason: "rollout_excluded" };
      }
      return { allow: true };
    },
  };
}

export function correlationIdBucket(correlationId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < correlationId.length; i++) {
    hash ^= correlationId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export function isInRolloutBucket(correlationId: string, rolloutPercent: number): boolean {
  if (rolloutPercent >= 100) return true;
  if (rolloutPercent <= 0) return false;
  return correlationIdBucket(correlationId) < rolloutPercent;
}
```

## B.5. `src/trigger/tasks/bandcamp-push-on-sku.ts` (full source — mirror reference for the new ShipStation per-SKU push)

```typescript
/**
 * Phase 4 — SHIP_NOTIFY (and any inventory-mutating event) → Bandcamp
 * focused per-SKU push.
 *
 * Triggered by `process-shipstation-shipment` after each line item's
 * successful `recordInventoryChange()`. Mirrors the new
 * `warehouse_inventory_levels.available` for that SKU onto Bandcamp via
 * `update_quantities`, gated through the `external_sync_events` ledger
 * keyed by `ship:{shipmentId}:{sku}` so retries are idempotent.
 *
 * Skip rules (in order):
 *   1. fanout-guard (bandcamp integration kill switch + rollout bucket)
 *   2. Variant not found in workspace
 *   3. Distro variant (warehouse_products.org_id IS NULL)
 *   4. No bandcamp_product_mappings row for the variant
 *   5. push_mode NOT IN ('normal','manual_override')
 *   6. Variant is a bundle parent (cron path handles bundles)
 *   7. Option-level mapping (deferred to cron path)
 *   8. Ledger short-circuit (already_in_flight / already_succeeded / already_errored)
 *
 * Push math: pushed_quantity = MAX(0, available - effective_safety)
 * where effective_safety = COALESCE(per_sku.safety_stock, workspace.default_safety_stock, 3)
 *
 * Rule #7  — service-role client.
 * Rule #9  — bandcampQueue (OAuth serialization).
 * Rule #12 — payload IDs only.
 * Rule #43 — fanout step (4) for SHIP_NOTIFY-originated inventory writes.
 */

import { logger, task } from "@trigger.dev/sdk";
import { refreshBandcampToken, updateQuantities } from "@/lib/clients/bandcamp";
import {
  beginExternalSync,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

export interface BandcampPushOnSkuPayload {
  workspaceId: string;
  sku: string;
  correlationId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export type BandcampPushOnSkuResult =
  | { status: "ok"; correlationId: string; sku: string; pushed_quantity: number; ledger_id: string }
  | {
      status:
        | "skipped_guard" | "skipped_unknown_variant" | "skipped_distro" | "skipped_no_mapping"
        | "skipped_push_mode" | "skipped_bundle_parent" | "skipped_option_level" | "skipped_ledger_duplicate";
      correlationId: string;
      sku: string;
      reason: string;
    };

export const bandcampPushOnSkuTask = task({
  id: "bandcamp-push-on-sku",
  queue: bandcampQueue,
  maxDuration: 60,
  run: async (payload: BandcampPushOnSkuPayload): Promise<BandcampPushOnSkuResult> => {
    const { workspaceId, sku, correlationId, reason, metadata } = payload;
    const supabase = createServiceRoleClient();

    // 1) fanout-guard
    const guard = await loadFanoutGuard(supabase, workspaceId);
    const decision = guard.evaluate("bandcamp", correlationId);
    if (!decision.allow) {
      return { status: "skipped_guard", correlationId, sku, reason: decision.reason };
    }

    // 2) resolve variant + owning product (for distro detection)
    const { data: variantRow } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, warehouse_products!inner(org_id)")
      .eq("workspace_id", workspaceId)
      .eq("sku", sku)
      .maybeSingle();

    const variant = variantRow as {
      id: string;
      sku: string;
      warehouse_products?: { org_id: string | null };
    } | null;

    if (!variant) {
      return { status: "skipped_unknown_variant", correlationId, sku, reason: "variant_not_found" };
    }

    // 3) distro skip
    if (variant.warehouse_products?.org_id == null) {
      return { status: "skipped_distro", correlationId, sku, reason: "org_id_is_null" };
    }

    // 4) bundle parent exclusion
    const { data: bundleHit } = await supabase
      .from("bundle_components")
      .select("bundle_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("bundle_variant_id", variant.id)
      .limit(1)
      .maybeSingle();

    if (bundleHit) {
      return {
        status: "skipped_bundle_parent",
        correlationId,
        sku,
        reason: "bundle_focused_push_deferred",
      };
    }

    // 5) Bandcamp mapping + push_mode gate
    const { data: mapping } = await supabase
      .from("bandcamp_product_mappings")
      .select(
        "id, bandcamp_item_id, bandcamp_item_type, push_mode, last_quantity_sold, bandcamp_origin_quantities",
      )
      .eq("workspace_id", workspaceId)
      .eq("variant_id", variant.id)
      .maybeSingle();

    if (!mapping || !mapping.bandcamp_item_id || !mapping.bandcamp_item_type) {
      return { status: "skipped_no_mapping", correlationId, sku, reason: "no_bandcamp_mapping" };
    }

    if (mapping.push_mode !== "normal" && mapping.push_mode !== "manual_override") {
      return {
        status: "skipped_push_mode",
        correlationId,
        sku,
        reason: `push_mode_${mapping.push_mode}`,
      };
    }

    // 6) option-level mapping defer
    const originQuantities = (mapping.bandcamp_origin_quantities ?? null) as Array<{
      option_quantities?: Array<unknown> | null;
    }> | null;
    const hasOptionLevel = !!originQuantities?.some(
      (o) => Array.isArray(o.option_quantities) && o.option_quantities.length > 0,
    );
    if (hasOptionLevel) {
      return {
        status: "skipped_option_level",
        correlationId,
        sku,
        reason: "option_level_focused_push_deferred",
      };
    }

    // 7) compute pushed_quantity
    const { data: level } = await supabase
      .from("warehouse_inventory_levels")
      .select("available, safety_stock")
      .eq("variant_id", variant.id)
      .maybeSingle();

    const available = level?.available ?? 0;
    const perSkuSafety = (level?.safety_stock as number | null) ?? null;

    const { data: ws } = await supabase
      .from("workspaces")
      .select("default_safety_stock")
      .eq("id", workspaceId)
      .single();

    const workspaceSafety = (ws?.default_safety_stock as number | null) ?? 3;
    const effectiveSafety = perSkuSafety ?? workspaceSafety;
    const pushedQuantity = Math.max(0, available - effectiveSafety);

    // 8) ledger acquire — idempotency
    const claim = await beginExternalSync(supabase, {
      system: "bandcamp",
      correlation_id: correlationId,
      sku,
      action: "modify",
      request_body: {
        bandcamp_item_id: mapping.bandcamp_item_id,
        bandcamp_item_type: mapping.bandcamp_item_type,
        quantity_available: pushedQuantity,
        quantity_sold: mapping.last_quantity_sold ?? 0,
        reason,
        metadata: metadata ?? null,
      },
    });

    if (!claim.acquired) {
      return { status: "skipped_ledger_duplicate", correlationId, sku, reason: claim.reason };
    }

    // 9) push to Bandcamp via OAuth (serialized via bandcampQueue)
    try {
      const accessToken = await refreshBandcampToken(workspaceId);
      await updateQuantities(
        [
          {
            item_id: mapping.bandcamp_item_id,
            item_type: mapping.bandcamp_item_type,
            quantity_available: pushedQuantity,
            quantity_sold: mapping.last_quantity_sold ?? 0,
          },
        ],
        accessToken,
      );
      await markExternalSyncSuccess(supabase, claim.id, {
        pushed_quantity: pushedQuantity,
        ok: true,
      });
      return {
        status: "ok",
        correlationId,
        sku,
        pushed_quantity: pushedQuantity,
        ledger_id: claim.id,
      };
    } catch (err) {
      await markExternalSyncError(supabase, claim.id, err);
      logger.error("[bandcamp-push-on-sku] updateQuantities failed", { workspaceId, sku, correlationId });
      throw err;
    }
  },
});
```

## B.6. `src/trigger/tasks/shipstation-v2-decrement.ts` (full source)

```typescript
/**
 * Phase 4 — sale-poll → ShipStation v2 decrement bridge.
 *
 * Triggered by `bandcamp-sale-poll` after a successful
 * `recordInventoryChange()` for a Bandcamp sale. Mirrors the decrement
 * onto ShipStation v2 inventory via the `external_sync_events` ledger
 * so retries are idempotent.
 *
 * Skip rules (in order):
 *   1. fanout-guard (shipstation kill switch + rollout bucket).
 *   2. Workspace has no v2 defaults configured.
 *   3. Variant is a bundle parent.
 *   4. Ledger short-circuit.
 *
 * Decrement contract: transaction_type: "decrement" with quantity: |delta|
 * for every case, including the 1 → 0 boundary. NEVER modify new_available: 0.
 */

import { logger, task } from "@trigger.dev/sdk";
import { adjustInventoryV2 } from "@/lib/clients/shipstation-inventory-v2";
import {
  beginExternalSync,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

export interface ShipstationV2DecrementPayload {
  workspaceId: string;
  sku: string;
  quantity: number;
  correlationId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export type ShipstationV2DecrementResult =
  | { status: "ok"; correlationId: string; sku: string; quantity: number; ledger_id: string }
  | {
      status:
        | "skipped_guard" | "skipped_no_v2_defaults" | "skipped_bundle_parent"
        | "skipped_unknown_variant" | "skipped_ledger_duplicate";
      correlationId: string;
      sku: string;
      reason: string;
    };

export const shipstationV2DecrementTask = task({
  id: "shipstation-v2-decrement",
  queue: shipstationQueue,
  maxDuration: 60,
  run: async (payload: ShipstationV2DecrementPayload): Promise<ShipstationV2DecrementResult> => {
    const { workspaceId, sku, quantity, correlationId, reason, metadata } = payload;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`[shipstation-v2-decrement] invalid quantity ${quantity}`);
    }

    const supabase = createServiceRoleClient();

    // 1) fanout-guard
    const guard = await loadFanoutGuard(supabase, workspaceId);
    const decision = guard.evaluate("shipstation", correlationId);
    if (!decision.allow) return { status: "skipped_guard", correlationId, sku, reason: decision.reason };

    // 2) workspace v2 defaults
    const { data: ws } = await supabase
      .from("workspaces")
      .select("shipstation_v2_inventory_warehouse_id, shipstation_v2_inventory_location_id")
      .eq("id", workspaceId)
      .single();

    const inventoryWarehouseId = ws?.shipstation_v2_inventory_warehouse_id ?? null;
    const inventoryLocationId = ws?.shipstation_v2_inventory_location_id ?? null;
    if (!inventoryWarehouseId || !inventoryLocationId) {
      return {
        status: "skipped_no_v2_defaults",
        correlationId,
        sku,
        reason: "workspace_v2_defaults_missing",
      };
    }

    // 3) bundle parent exclusion
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("sku", sku)
      .maybeSingle();

    if (!variant) return { status: "skipped_unknown_variant", correlationId, sku, reason: "variant_not_found" };

    const { data: bundleHit } = await supabase
      .from("bundle_components")
      .select("bundle_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("bundle_variant_id", variant.id)
      .limit(1)
      .maybeSingle();

    if (bundleHit) {
      return { status: "skipped_bundle_parent", correlationId, sku, reason: "bundle_excluded_from_v2" };
    }

    // 4) ledger acquire
    const claim = await beginExternalSync(supabase, {
      system: "shipstation_v2",
      correlation_id: correlationId,
      sku,
      action: "decrement",
      request_body: {
        quantity,
        reason,
        inventory_warehouse_id: inventoryWarehouseId,
        inventory_location_id: inventoryLocationId,
        metadata: metadata ?? null,
      },
    });

    if (!claim.acquired) {
      return { status: "skipped_ledger_duplicate", correlationId, sku, reason: claim.reason };
    }

    // 5) v2 decrement (NEVER modify; Phase 0 Patch D2 contract)
    try {
      const response = await adjustInventoryV2({
        sku,
        inventory_warehouse_id: inventoryWarehouseId,
        inventory_location_id: inventoryLocationId,
        transaction_type: "decrement",
        quantity,
        reason,
        notes: metadata ? JSON.stringify(metadata).slice(0, 500) : undefined,
      });
      await markExternalSyncSuccess(supabase, claim.id, response);
      return { status: "ok", correlationId, sku, quantity, ledger_id: claim.id };
    } catch (err) {
      await markExternalSyncError(supabase, claim.id, err);
      logger.error("[shipstation-v2-decrement] adjustInventoryV2 failed", { workspaceId, sku });
      throw err;
    }
  },
});
```

## B.7. `src/lib/clients/shipstation-inventory-v2.ts` (full source — file to be extended in Workstream 3)

See full source in repository at `src/lib/clients/shipstation-inventory-v2.ts` — 300 lines reproduced verbatim above in Section §3 of this plan when reviewing the existing batch-only invariants. Critical exports already present:

- `V2_INVENTORY_LIST_BATCH_LIMIT = 50` constant.
- Type exports: `InventoryRecord`, `ListInventoryParams`, `V2TransactionType`, `AdjustInventoryParams`, `V2InventoryWarehouse`, `V2InventoryLocation`.
- Functions: `listInventory(params)`, `adjustInventoryV2(params)`, `listInventoryWarehouses()`, `listInventoryLocations(inventoryWarehouseId)`.
- Internal: `v2Fetch<T>(path, options?)` (the `api-key` header HTTP client).
- Hard CI guard: file contains an explicit "EXPLICITLY NOT EXPORTED" footer banning single-SKU read helpers; `scripts/check-v2-inventory-batch.sh` greps the build for forbidden symbol shapes.

The client-side validation in `adjustInventoryV2` enforces Patch D2:

```typescript
if (transaction_type === "modify") {
  if (params.new_available === undefined) throw new Error("modify requires new_available");
  if (params.new_available < 1) {
    throw new Error("modify rejected: ShipStation v2 cannot zero a SKU via modify; use decrement or adjust quantity:0");
  }
} else {
  if (params.quantity === undefined) throw new Error(`${transaction_type} requires quantity`);
  if (transaction_type !== "adjust" && params.quantity < 1) {
    throw new Error(`${transaction_type} rejected: quantity < 1`);
  }
  if (params.quantity < 0) throw new Error(`${transaction_type} rejected: negative quantity`);
}
```

The new `createInventoryLocation`, `updateInventoryLocation`, `deleteInventoryLocation` (Appendix C.11) extend this file using the same `v2Fetch<T>` pattern.

## B.8. `src/app/admin/inventory/page.tsx` (full source — file to be extended in Workstream 1.5/3 + Sunday polish)

The full 504-line source was reviewed inline during planning. Key shape relevant to the patches:

- Line 47-66: component declaration, filters state, `expandedSku` state, `adjustDialog` state, `adjustDelta`/`adjustReason` state, `exporting` state.
- Line 68-95: `useAppQuery` for orgs, inventory levels, and inventory detail (when `expandedSku` is set).
- Line 101-112: `adjustMutation` via `useAppMutation`, calls `adjustInventory(sku, delta, reason)`.
- Line 207-432: the `<Table>` with rows + expanded detail section. The expanded detail is at lines 346-419 — this is where the count session panel inserts.
- Line 282-294: the inline-editable Avail cell. Wrapped in an `<EditableNumberCell>` whose `onSave` calls `adjustInventory(row.sku, target - row.available, "Inline quantity edit")`.
- Line 446-500: the Adjust dialog. Currently delta-only; the Sunday polish adds the "Set to" mode as a tab toggle.

The expanded detail section (lines 346-419) currently shows two side-by-side panels: Locations (list of locationName + quantity, plus Bandcamp link) and Recent Activity. The new Count session panel inserts ABOVE the existing Locations panel, taking full width when `count_status === 'count_in_progress'`.

## B.9. Supporting files (signature-level summary)

### B.9.1. `src/lib/shared/types.ts` (relevant excerpts)

```typescript
export type InventorySource =
  | "shopify" | "bandcamp" | "squarespace" | "woocommerce" | "shipstation"
  | "manual" | "inbound" | "preorder" | "backfill" | "reconcile";
// PROPOSED EXTENSION: add 'cycle_count' and 'manual_inventory_count'

export type IntegrationKillSwitchKey =
  | "shipstation" | "bandcamp" | "clandestine_shopify" | "client_store";
// Already includes 'shipstation' from Tier 1 hardening; no extension needed.

export interface Workspace {
  // ...existing fields...
  shipstation_sync_paused: boolean;
  bandcamp_sync_paused: boolean;
  clandestine_shopify_sync_paused: boolean;
  client_store_sync_paused: boolean;
  inventory_sync_paused: boolean;
  fanout_rollout_percent: number;
  shipstation_v2_inventory_warehouse_id: string | null;
  shipstation_v2_inventory_location_id: string | null;
  default_safety_stock: number | null;
}

export interface WarehouseInventoryLevel {
  variant_id: string;
  workspace_id: string;
  org_id: string | null;
  on_hand: number;
  available: number;
  committed: number;
  incoming: number;
  safety_stock: number | null;
  last_redis_write_at: string | null;
  // PROPOSED EXTENSIONS:
  count_status: "idle" | "count_in_progress";
  count_started_at: string | null;
  count_started_by: string | null;
}

export interface WarehouseLocation {
  id: string;
  workspace_id: string;
  name: string;
  type: string;
  barcode: string | null;
  is_active: boolean;
  // PROPOSED EXTENSIONS:
  shipstation_inventory_location_id: string | null;
  shipstation_synced_at: string | null;
  shipstation_sync_error: string | null;
}

// PROPOSED NEW TYPE:
export type CountStatus = "idle" | "count_in_progress";
```

### B.9.2. `src/lib/shared/env.ts` (relevant excerpts)

```typescript
// Server-only env Zod schema includes:
SHIPSTATION_V2_API_KEY: z.string().min(1),  // required for v2 calls
SHIPSTATION_API_KEY: z.string().min(1),     // v1 (alias path)
SHIPSTATION_API_SECRET: z.string().min(1),  // v1
BANDCAMP_API_KEY: z.string().min(1),
BANDCAMP_API_SECRET: z.string().min(1),
SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
DATABASE_URL: z.string().url(),  // Supavisor port 6543
DIRECT_URL: z.string().url(),    // direct port 5432, migration CLI only
UPSTASH_REDIS_REST_URL: z.string().url(),
UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
SENTRY_DSN: z.string().optional(),
TRIGGER_SECRET_KEY: z.string().min(1),
RESEND_API_KEY: z.string().optional(),
EASYPOST_API_KEY: z.string().optional(),
```

No new env vars required by this plan.

### B.9.3. `src/trigger/lib/bandcamp-queue.ts`

```typescript
import { queue } from "@trigger.dev/sdk";
export const bandcampQueue = queue({ name: "bandcamp-api", concurrencyLimit: 1 });
```

Used by `bandcamp-sale-poll`, `bandcamp-inventory-push`, `bandcamp-sync`, `bandcamp-push-on-sku`. No change.

### B.9.4. `src/trigger/lib/shipstation-queue.ts`

```typescript
import { queue } from "@trigger.dev/sdk";
export const shipstationQueue = queue({ name: "shipstation", concurrencyLimit: 1 });
```

Used by `shipstation-poll`, `process-shipstation-shipment`, `shipstation-v2-decrement`, `shipstation-bandcamp-reconcile-{hot,warm,cold}`. The new `shipstation-v2-adjust-on-sku` (shipped name; planned as `shipstation-v2-sync-on-sku`), `megaplan-spot-check`, and `bulk-create-locations` also pin to this queue.

### B.9.5. `src/trigger/tasks/index.ts`

Currently exports task constants for every shipped task. PROPOSED ADDITIONS:

```typescript
export { megaplanSpotCheckTask } from "./megaplan-spot-check";
export { deferredFollowupsReminderTask } from "./deferred-followups-reminder";
// SHIPPED FORM (2026-04-13, audit fix F1):
// export { shipstationV2AdjustOnSkuTask } from "./shipstation-v2-adjust-on-sku";
// (the original plan name `shipstationV2SyncOnSkuTask` from `./shipstation-v2-sync-on-sku`
//  is preserved here historically — the task was renamed during WS2 build because it
//  handles BOTH delta directions, and the Appendix C.5 per-location form remains gated
//  on the §15.3 probe.)
export { shipstationV2SyncOnSkuTask } from "./shipstation-v2-sync-on-sku";
```

### B.9.6. `src/actions/inventory.ts` (relevant excerpt — `adjustInventory`)

This is the actual source verified against the codebase in the v6 verification pass. Auth is inlined (does NOT use `requireStaff()` here — the action calls `supabase.auth.getUser()` and resolves `workspace_id` directly to avoid a double round-trip):

```typescript
export async function adjustInventory(
  sku: string,
  delta: number,
  reason: string,
): Promise<{ success: boolean; newQuantity: number | null }> {
  const validated = adjustInventorySchema.parse({ sku, delta, reason });
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("workspace_id")
    .eq("auth_user_id", user.id)
    .single();
  if (userError || !userData) throw new Error("Failed to resolve workspace");

  const correlationId = `manual:${user.id}:${Date.now()}`;

  const result = await recordInventoryChange({
    workspaceId: userData.workspace_id,
    sku: validated.sku,
    delta: validated.delta,
    source: "manual",
    correlationId,
    metadata: { reason: validated.reason, adjusted_by: user.id },
  });

  return { success: result.success, newQuantity: result.newQuantity };
}
```

This is the core path that already routes through `recordInventoryChange()`. After the Workstream 2 fanout extension lands, this same Server Action triggers ShipStation v2 fanout automatically — no signature change required. New plan-introduced Server Actions in C.6 / C.7 / C.8 use the typed `requireStaff()` helper from `@/lib/server/auth-context.ts` which returns `{ userId, workspaceId }` (NOT `{ user, workspaceId }` — that was a v5-and-earlier plan misnomer corrected in v6).

### B.9.7. `src/actions/scanning.ts` (relevant excerpt — `submitCount` is the dormant scanner path)

```typescript
export async function submitCount(
  locationId: string,
  counts: Array<{ sku: string; scannedCount: number; expectedCount: number }>,
) {
  // Updates warehouse_variant_locations directly (does NOT route through recordInventoryChange).
  // Creates warehouse_review_queue items for mismatches.
  // NOT used by the new manual-entry flow on /admin/inventory; left in place pending Phase 7.
}
```

Plan does NOT modify this file. The new `inventory-counts.ts` Server Actions are the canonical path for the locator + count session UI.

---

# Appendix C — Proposed new code (skeletons)

Each skeleton below is implementation-quality enough that a reviewer can validate the design. The agent will flesh out edge cases during the Saturday build but the core control flow, idempotency keys, and external API calls are pinned here.

## C.1. `supabase/migrations/20260413000040_megaplan_spot_check_runs.sql`

```sql
-- Phase 6 closeout — automated 5-SKU-per-client spot-check artifact storage.
-- Run hourly during ramp weekend (Sat-Mon), then daily.

create table megaplan_spot_check_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  sampled_sku_count integer not null default 0,
  drift_agreed_count integer not null default 0,
  drift_minor_count integer not null default 0,
  drift_major_count integer not null default 0,
  delayed_propagation_count integer not null default 0,
  summary_json jsonb not null default '{}'::jsonb,
  artifact_md text,
  created_by uuid references users(id)
);

create index megaplan_spot_check_runs_started_idx on megaplan_spot_check_runs (started_at desc);
create index megaplan_spot_check_runs_workspace_idx on megaplan_spot_check_runs (workspace_id, started_at desc);

alter table megaplan_spot_check_runs enable row level security;

create policy "staff_select_megaplan_spot_check_runs"
  on megaplan_spot_check_runs for select
  to authenticated
  using (is_staff_user());

create policy "service_role_all_megaplan_spot_check_runs"
  on megaplan_spot_check_runs for all
  to service_role
  using (true)
  with check (true);
```

## C.2. `supabase/migrations/20260413000050_phase4b_shipstation_fanout.sql` (planned filename — shipped as `20260418000001_phase4b_megaplan_closeout_and_count_session.sql`)

```sql
-- Phase 4b — ShipStation v2 as fanout target + per-SKU count session
-- + ShipStation location mirror columns + cycle_count source values.

-- 1) ShipStation kill switch (Tier 1 #1) — additive, defaults to off
alter table workspaces
  add column if not exists shipstation_sync_paused boolean not null default false,
  add column if not exists shipstation_sync_paused_at timestamptz,
  add column if not exists shipstation_sync_paused_by uuid references users(id),
  add column if not exists shipstation_sync_paused_reason text;

-- 2) Per-SKU count session columns
alter table warehouse_inventory_levels
  add column if not exists count_status text not null default 'idle'
    check (count_status in ('idle', 'count_in_progress')),
  add column if not exists count_started_at timestamptz,
  add column if not exists count_started_by uuid references users(id),
  -- count_baseline_available: snapshot of available at startCountSession.
  -- AUDIT-ONLY (review pass v3 corrected): completeCountSession uses CURRENT
  -- available for delta math, NOT baseline. Baseline is retained so the
  -- cycle_count activity row can record both values, allowing post-hoc
  -- detection of "sale landed during session" cases (sales_during_session =
  -- baseline - current_at_complete). See C.8 commentary for the rationale.
  add column if not exists count_baseline_available integer,
  -- Hardening R-23 (review pass v4): once a SKU has per-location data, the
  -- ShipStation v2 fanout MUST always write per-location, never fall back to
  -- single SKU-total writes. Otherwise a transient empty-per-location state
  -- would overwrite ShipStation's per-location records with one workspace-
  -- default-location write, causing drift. Set to true on first non-zero
  -- per-location write; never reset.
  add column if not exists has_per_location_data boolean not null default false;

create index if not exists warehouse_inventory_levels_count_in_progress_idx
  on warehouse_inventory_levels (workspace_id)
  where count_status = 'count_in_progress';

-- Auto-stale-cancel helper: review queue picks SKUs in_progress > 24 hr.
-- See §31 halt condition for the policy: at 24 hr, the deferred-followups
-- pattern auto-creates a 'stale-count-session' review queue item AND the
-- next inbound mutation through recordInventoryChange() force-resets the
-- session (count_status = 'idle', count_baseline_available = null) to
-- unblock fanout. Per-location entries are preserved.

-- 3) ShipStation location mirror columns
alter table warehouse_locations
  add column if not exists shipstation_inventory_location_id text,
  add column if not exists shipstation_synced_at timestamptz,
  add column if not exists shipstation_sync_error text;

create index if not exists warehouse_locations_shipstation_id_idx
  on warehouse_locations (shipstation_inventory_location_id)
  where shipstation_inventory_location_id is not null;

create index if not exists warehouse_locations_shipstation_error_idx
  on warehouse_locations (workspace_id)
  where shipstation_sync_error is not null;

-- 4) Extend InventorySource enum on warehouse_inventory_activity
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'warehouse_inventory_activity_source_check'
  ) then
    alter table warehouse_inventory_activity
      drop constraint warehouse_inventory_activity_source_check;
  end if;
end$$;

alter table warehouse_inventory_activity
  add constraint warehouse_inventory_activity_source_check
  check (source in (
    'shopify','bandcamp','squarespace','woocommerce','shipstation',
    'manual','inbound','preorder','backfill','reconcile',
    'cycle_count','manual_inventory_count'
  ));

-- 5) Comments for clarity
comment on column warehouse_inventory_levels.count_status is
  'When count_in_progress, fanout is suppressed for per-location quantity writes; only completeCountSession() fires fanout. See CLAUDE.md Rule #74.';
comment on column warehouse_locations.shipstation_inventory_location_id is
  'ShipStation v2 inventory_location_id mirrored from createLocation() Server Action. Our app is source of truth (Rule #75).';
```

## C.3. `src/trigger/tasks/megaplan-spot-check.ts`

```typescript
/**
 * Hourly (then daily) cross-system inventory verification.
 * Samples 5 SKUs per active client, classifies drift, persists artifact,
 * creates review queue item on drift_major.
 */
import { logger, schedules } from "@trigger.dev/sdk";
import { listInventory } from "@/lib/clients/shipstation-inventory-v2";
import { getInventoryLevel as redisGetLevel } from "@/lib/clients/redis-inventory";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

interface SkuRow {
  sku: string;
  variantId: string;
  workspaceId: string;
  dbAvailable: number;
  redisAvailable: number | null;
  shipstationAvailable: number | null;
  bandcampAvailable: number | null;
  classification: "agreed" | "delayed_propagation" | "drift_minor" | "drift_major";
}

export const megaplanSpotCheckTask = schedules.task({
  id: "megaplan-spot-check",
  queue: shipstationQueue,
  cron: "0 * * * *", // hourly during ramp; switch to "0 9 * * *" Tuesday
  run: async () => {
    const supabase = createServiceRoleClient();
    const startedAt = new Date().toISOString();

    const { data: workspaces } = await supabase
      .from("workspaces")
      .select("id, name");

    for (const ws of workspaces ?? []) {
      const { data: runRow } = await supabase
        .from("megaplan_spot_check_runs")
        .insert({ workspace_id: ws.id, started_at: startedAt })
        .select("id")
        .single();
      if (!runRow) continue;

      // Hardening (review pass v4 §5.1): during ramp window (Sun-Mon), sample
      // 15 SKUs prioritized by recent activity. After ramp, revert to 5 daily.
      // Detection: if any workspace has fanout_rollout_percent < 100 we treat
      // the system as "in ramp" and use the larger sample.
      const { data: rampCheck } = await supabase
        .from("workspaces")
        .select("id")
        .lt("fanout_rollout_percent", 100)
        .limit(1);
      const inRamp = (rampCheck ?? []).length > 0;
      const perClient = inRamp ? 15 : 5;

      // Sample SKUs per client. Prioritize: (1) SKUs with activity in last 4 hr,
      // (2) SKUs with active count_in_progress are EXCLUDED (transient drift
      // expected — they'd skew classification). RPC handles both filters.
      const { data: sampled } = await supabase.rpc("megaplan_sample_skus_per_client", {
        p_workspace_id: ws.id,
        p_per_client: perClient,
        p_exclude_count_in_progress: true,
        p_prioritize_recent_activity_hours: 4,
      });

      const rows: SkuRow[] = [];
      for (const row of (sampled ?? []) as Array<{ sku: string; variant_id: string; workspace_id: string }>) {
        // DB
        const { data: level } = await supabase
          .from("warehouse_inventory_levels")
          .select("available")
          .eq("variant_id", row.variant_id)
          .single();
        const dbAvailable = level?.available ?? 0;

        // Redis
        const redisAvailable = await redisGetLevel(row.sku, "available").catch(() => null);

        // ShipStation v2
        let shipstationAvailable: number | null = null;
        try {
          const records = await listInventory({ skus: [row.sku] });
          shipstationAvailable = records.length > 0 ? records[0].available : 0;
        } catch (err) {
          logger.warn("[spot-check] ShipStation read failed", { sku: row.sku, err });
        }

        // Bandcamp pushed value
        const { data: mapping } = await supabase
          .from("bandcamp_product_mappings")
          .select("bandcamp_origin_quantities")
          .eq("workspace_id", ws.id)
          .eq("variant_id", row.variant_id)
          .maybeSingle();
        const bandcampAvailable = extractBandcampPushedQuantity(mapping?.bandcamp_origin_quantities);

        const classification = classify(dbAvailable, redisAvailable, shipstationAvailable, bandcampAvailable);
        rows.push({
          sku: row.sku, variantId: row.variant_id, workspaceId: ws.id,
          dbAvailable, redisAvailable, shipstationAvailable, bandcampAvailable, classification,
        });
      }

      const summary = summarize(rows);
      const artifactMd = renderArtifactMarkdown(ws, rows, summary);

      await supabase
        .from("megaplan_spot_check_runs")
        .update({
          finished_at: new Date().toISOString(),
          sampled_sku_count: rows.length,
          drift_agreed_count: summary.agreed,
          drift_minor_count: summary.minor,
          drift_major_count: summary.major,
          delayed_propagation_count: summary.delayed,
          summary_json: { rows },
          artifact_md: artifactMd,
        })
        .eq("id", runRow.id);

      // Hardening (review pass v4 §5.3): persistence rule — drift_major must
      // appear in TWO consecutive runs for the same SKU before creating a
      // review queue item. Eliminates transient ShipStation/Bandcamp lag noise.
      const driftMajorSkus = rows.filter((r) => r.classification === "drift_major").map((r) => r.sku);
      if (driftMajorSkus.length > 0) {
        const { data: priorRun } = await supabase
          .from("megaplan_spot_check_runs")
          .select("summary_json")
          .eq("workspace_id", ws.id)
          .lt("started_at", startedAt)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const priorMajorSkus = new Set<string>(
          ((priorRun?.summary_json as { rows?: Array<{ sku: string; classification: string }> } | null)?.rows ?? [])
            .filter((r) => r.classification === "drift_major")
            .map((r) => r.sku),
        );
        const persistedMajor = driftMajorSkus.filter((sku) => priorMajorSkus.has(sku));
        if (persistedMajor.length > 0) {
          await supabase.from("warehouse_review_queue").insert({
            workspace_id: ws.id,
            severity: "critical",
            group_key: "megaplan-spot-check-drift-major-persisted",
            title: `Spot-check: ${persistedMajor.length} SKUs in drift_major for 2 consecutive runs`,
            context: {
              run_id: runRow.id,
              persisted_skus: persistedMajor,
              all_drift_major_this_run: driftMajorSkus,
            },
          });
        } else {
          logger.info("[spot-check] drift_major SKUs detected but did not persist from prior run — no review item created", {
            workspace_id: ws.id,
            transient_skus: driftMajorSkus,
          });
        }
      }
    }
  },
});

function classify(db: number, redis: number | null, ss: number | null, bc: number | null) {
  if (redis === null || ss === null || bc === null) return "drift_major";
  if (db === redis && db === ss && db === bc) return "agreed";
  if (db === redis && (Math.abs(db - ss) > 0 || Math.abs(db - bc) > 0)) {
    // TODO: check last_pushed_at to distinguish delayed vs drift
    return "delayed_propagation";
  }
  const maxDiff = Math.max(Math.abs(db - (redis ?? db)), Math.abs(db - ss), Math.abs(db - bc));
  return maxDiff <= 2 ? "drift_minor" : "drift_major";
}

function summarize(rows: SkuRow[]) {
  return {
    agreed: rows.filter((r) => r.classification === "agreed").length,
    delayed: rows.filter((r) => r.classification === "delayed_propagation").length,
    minor: rows.filter((r) => r.classification === "drift_minor").length,
    major: rows.filter((r) => r.classification === "drift_major").length,
  };
}

function renderArtifactMarkdown(ws: { id: string; name: string | null }, rows: SkuRow[], summary: ReturnType<typeof summarize>) {
  const header = `# Spot-check ${new Date().toISOString()} — ${ws.name ?? ws.id}\n\n`;
  const sum = `**Summary:** ${summary.agreed} agreed | ${summary.delayed} delayed | ${summary.minor} minor | ${summary.major} major\n\n`;
  const table = "| SKU | DB | Redis | ShipStation | Bandcamp | Class |\n|---|---:|---:|---:|---:|---|\n" +
    rows.map((r) => `| ${r.sku} | ${r.dbAvailable} | ${r.redisAvailable ?? "—"} | ${r.shipstationAvailable ?? "—"} | ${r.bandcampAvailable ?? "—"} | ${r.classification} |`).join("\n");
  return header + sum + table;
}

function extractBandcampPushedQuantity(originQuantities: unknown): number | null {
  if (!Array.isArray(originQuantities) || originQuantities.length === 0) return null;
  const first = originQuantities[0] as { quantity_available?: number } | null;
  return typeof first?.quantity_available === "number" ? first.quantity_available : null;
}
```

A companion Postgres function `megaplan_sample_skus_per_client` is added in the same migration as a helper RPC. **The v6 verification pass confirmed this RPC does NOT exist in `supabase/migrations/`** — it MUST be created as part of the C.1 migration (`20260413000040_megaplan_spot_check_runs.sql`). Suggested DDL (idempotent):

```sql
-- Sampler RPC consumed by megaplan-spot-check task.
-- Returns up to `p_per_client` SKUs per workspace with org_id, prioritized by
-- recent inventory activity (LEFT JOIN on warehouse_inventory_activity within
-- the last 24h ORDER BY recent activity DESC, falls back to random tie-break).
-- Excludes SKUs currently in count_in_progress (R-1 hardening).
create or replace function megaplan_sample_skus_per_client(p_per_client int)
returns table (
  workspace_id uuid,
  workspace_name text,
  org_id uuid,
  sku text
)
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select
      l.workspace_id,
      w.name as workspace_name,
      l.org_id,
      l.sku,
      coalesce(max(a.created_at), 'epoch'::timestamptz) as last_activity_at,
      row_number() over (
        partition by l.workspace_id, l.org_id
        order by coalesce(max(a.created_at), 'epoch'::timestamptz) desc, random()
      ) as rn
    from warehouse_inventory_levels l
    join workspaces w on w.id = l.workspace_id
    left join warehouse_inventory_activity a
      on a.sku = l.sku
      and a.workspace_id = l.workspace_id
      and a.created_at > (now() - interval '24 hours')
    where l.org_id is not null
      and coalesce(l.count_status, 'idle') = 'idle'  -- R-1: skip in-progress counts
    group by l.workspace_id, w.name, l.org_id, l.sku
  )
  select workspace_id, workspace_name, org_id, sku
  from ranked
  where rn <= p_per_client;
$$;

grant execute on function megaplan_sample_skus_per_client(int) to service_role;
```

Notes for the build agent:
- The `coalesce(l.count_status, 'idle') = 'idle'` filter requires Migration 50 (which adds `count_status`) to ship BEFORE Migration 40 OR for the function to be created in a SECOND migration sequenced after Migration 50. **Resolved during WS1 build (2026-04-18):** the dependency was solved by bundling spot-check + count-session schema into a single migration `20260418000001_phase4b_megaplan_closeout_and_count_session.sql` so the column dependency is satisfied within one transaction. The original `20260413000040`/`20260413000050`/`20260413000060` triple-sequence numbering was abandoned in favor of the bundled file.
- If the operator runs the spot-check before Migration 50 ships, the `coalesce(...)` clause becomes a no-op (column missing → coalesce returns the literal `'idle'`) and the filter accepts every row. This is safe behavior — no count sessions exist yet.

## C.4. `src/trigger/tasks/deferred-followups-reminder.ts`

```typescript
/**
 * Daily reminder cron. Parses docs/DEFERRED_FOLLOWUPS.md (YAML front matter
 * with an array of entries) and creates a warehouse_review_queue item per
 * entry whose due_date <= today. Idempotent via correlation_id.
 */
import { schedules } from "@trigger.dev/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface DeferredEntry {
  slug: string;
  title: string;
  due_date: string;
  severity: "low" | "medium" | "high" | "critical";
  context: string;
}

export const deferredFollowupsReminderTask = schedules.task({
  id: "deferred-followups-reminder",
  cron: "0 9 * * *", // daily 09:00 UTC; operator can shift to 09:00 ET
  run: async () => {
    const filePath = path.join(process.cwd(), "docs", "DEFERRED_FOLLOWUPS.md");
    const raw = await readFile(filePath, "utf-8");
    const yamlBlock = raw.match(/^---\n([\s\S]+?)\n---/);
    if (!yamlBlock) throw new Error("DEFERRED_FOLLOWUPS.md missing YAML front matter");

    const entries = yaml.parse(yamlBlock[1]) as DeferredEntry[];
    const today = new Date().toISOString().slice(0, 10);
    const supabase = createServiceRoleClient();

    const { data: workspaces } = await supabase.from("workspaces").select("id");
    const workspaceIds = (workspaces ?? []).map((w) => w.id);

    for (const entry of entries) {
      if (entry.due_date > today) continue;
      for (const wsId of workspaceIds) {
        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: wsId,
            severity: entry.severity,
            group_key: `deferred-followup-${entry.slug}`,
            correlation_id: `deferred:${entry.slug}:${entry.due_date}`,
            title: `Deferred follow-up due: ${entry.title}`,
            context: { slug: entry.slug, due_date: entry.due_date, context: entry.context },
          },
          { onConflict: "correlation_id" },
        );
      }
    }
  },
});
```

## C.5. `src/trigger/tasks/shipstation-v2-sync-on-sku.ts` (per-location semantics — final form)

```typescript
/**
 * Phase 4b — fanout target #4: ShipStation v2 per-SKU push.
 *
 * Triggered by fanoutInventoryChange() after recordInventoryChange().
 * For SKUs with per-location data (warehouse_variant_locations rows mapped
 * to ShipStation IDs): writes per-location absolute quantities.
 * For SKUs without per-location data: falls back to a single SKU-total
 * write to the workspace-default location.
 *
 * Per-location writes use transaction_type: 'modify' new_available: per_location_qty
 * (Patch D2 contract: per-location qty must be >= 1; for 0 use adjust quantity:0
 * BUT only if the location has been previously seeded — see hardening below).
 *
 * HARDENING (review pass 2026-04-19, ref R-20):
 * `adjust quantity: 0` on a location that has NEVER had inventory recorded in
 * ShipStation will 400 (no row to adjust against). For brand-new mirrored
 * locations created Tue/Wed where the count happens to be 0, we SKIP the write
 * entirely and let the next non-zero count seed the row via `modify`. The
 * tiered reconcile sensor catches any SKU where DB has 0 and ShipStation has
 * a stale non-zero — that becomes a `drift_minor` and gets auto-corrected.
 *
 * Each per-location write gets its own external_sync_events row keyed
 * (workspace_id, sku, correlation_id + ':loc:' + locationId, action='modify').
 */
import { logger, task } from "@trigger.dev/sdk";
import { adjustInventoryV2 } from "@/lib/clients/shipstation-inventory-v2";
import {
  beginExternalSync,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

export interface ShipstationV2SyncOnSkuPayload {
  workspaceId: string;
  sku: string;
  correlationId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export const shipstationV2SyncOnSkuTask = task({
  id: "shipstation-v2-sync-on-sku",
  queue: shipstationQueue,
  maxDuration: 60,
  run: async (payload: ShipstationV2SyncOnSkuPayload) => {
    const { workspaceId, sku, correlationId, reason, metadata } = payload;
    const supabase = createServiceRoleClient();

    // 1) fanout-guard
    const guard = await loadFanoutGuard(supabase, workspaceId);
    const decision = guard.evaluate("shipstation", correlationId);
    if (!decision.allow) return { status: "skipped_guard" as const, reason: decision.reason };

    // 2) workspace v2 defaults (needed for fallback case)
    const { data: ws } = await supabase
      .from("workspaces")
      .select("shipstation_v2_inventory_warehouse_id, shipstation_v2_inventory_location_id, shipstation_sync_paused")
      .eq("id", workspaceId)
      .single();
    if (ws?.shipstation_sync_paused) return { status: "skipped_kill_switch" as const };
    if (!ws?.shipstation_v2_inventory_warehouse_id || !ws?.shipstation_v2_inventory_location_id) {
      return { status: "skipped_no_v2_defaults" as const };
    }

    // 3) variant + bundle/distro exclusion
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id, warehouse_products!inner(org_id)")
      .eq("workspace_id", workspaceId)
      .eq("sku", sku)
      .maybeSingle();
    const v = variant as { id: string; warehouse_products?: { org_id: string | null } } | null;
    if (!v) return { status: "skipped_unknown_variant" as const };
    if (v.warehouse_products?.org_id == null) return { status: "skipped_distro" as const };

    const { data: bundleHit } = await supabase
      .from("bundle_components")
      .select("bundle_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("bundle_variant_id", v.id)
      .limit(1)
      .maybeSingle();
    if (bundleHit) return { status: "skipped_bundle_parent" as const };

    // 4) read per-location data + has_per_location_data sticky flag (R-23)
    const { data: perLocation } = await supabase
      .from("warehouse_variant_locations")
      .select("location_id, quantity, warehouse_locations!inner(shipstation_inventory_location_id)")
      .eq("variant_id", v.id);

    const { data: levelFlags } = await supabase
      .from("warehouse_inventory_levels")
      .select("has_per_location_data")
      .eq("variant_id", v.id)
      .maybeSingle();
    const skuIsPerLocation = (levelFlags?.has_per_location_data ?? false) || (perLocation ?? []).length > 0;

    const mapped = (perLocation ?? []).filter((r: any) => r.warehouse_locations?.shipstation_inventory_location_id);
    const hasMappedPerLocation = mapped.length > 0;

    // R-23 hardening: if SKU has EVER had per-location data but currently has
    // no mapped rows (either rows deleted or all locations awaiting mirror),
    // do NOT fall back to SKU-total — that would overwrite ShipStation's
    // per-location records with one workspace-default write. Skip and surface
    // a review queue item via reconcile sensor instead.
    if (skuIsPerLocation && !hasMappedPerLocation) {
      logger.warn("[shipstation-v2-sync] SKU has per-location history but no mapped rows — skipping to prevent overwrite", { sku });
      return { status: "skipped_per_location_history_no_mapped" as const };
    }

    // 5) per-location path
    if (hasMappedPerLocation) {
      const writes: Array<{ locationId: string; ssLocationId: string; quantity: number }> = [];
      for (const row of mapped as any[]) {
        writes.push({
          locationId: row.location_id,
          ssLocationId: row.warehouse_locations.shipstation_inventory_location_id,
          quantity: row.quantity,
        });
      }

      const results: Array<{ locationId: string; status: "ok" | "skipped" | "error"; ledger_id?: string }> = [];
      for (const write of writes) {
        const corr = `${correlationId}:loc:${write.locationId}`;
        const claim = await beginExternalSync(supabase, {
          system: "shipstation_v2",
          correlation_id: corr,
          sku,
          action: "modify",
          request_body: { quantity: write.quantity, location_id: write.locationId, reason },
        });
        if (!claim.acquired) {
          results.push({ locationId: write.locationId, status: "skipped" });
          continue;
        }
        try {
          if (write.quantity === 0) {
            // R-20 hardening: try `adjust quantity: 0` first; if v2 returns 400/404
            // ("no inventory row to adjust"), the location was never seeded and we
            // skip — reconcile catches any drift later. Don't error-propagate.
            try {
              await adjustInventoryV2({
                sku,
                inventory_warehouse_id: ws.shipstation_v2_inventory_warehouse_id,
                inventory_location_id: write.ssLocationId,
                transaction_type: "adjust",
                quantity: 0,
                reason,
              });
            } catch (zeroErr) {
              const zMsg = zeroErr instanceof Error ? zeroErr.message : String(zeroErr);
              const isNotSeeded = /400|404|no.*inventory|not.*found/i.test(zMsg);
              if (!isNotSeeded) throw zeroErr;
              // skip path: log to ledger but mark as "ok_noop" so reconcile knows
              await markExternalSyncSuccess(supabase, claim.id);
              results.push({ locationId: write.locationId, status: "ok", ledger_id: claim.id });
              continue;
            }
          } else {
            await adjustInventoryV2({
              sku,
              inventory_warehouse_id: ws.shipstation_v2_inventory_warehouse_id,
              inventory_location_id: write.ssLocationId,
              transaction_type: "modify",
              new_available: write.quantity,
              reason,
            });
          }
          await markExternalSyncSuccess(supabase, claim.id);
          results.push({ locationId: write.locationId, status: "ok", ledger_id: claim.id });
        } catch (err) {
          await markExternalSyncError(supabase, claim.id, err);
          results.push({ locationId: write.locationId, status: "error" });
          // Continue with other locations; do not throw
        }
      }
      // Skip locations with no shipstation_inventory_location_id (queued for retry on next sync after mirror succeeds)
      const skippedUnmapped = (perLocation ?? []).length - mapped.length;
      return { status: "ok_per_location" as const, writes: results, skipped_unmapped: skippedUnmapped };
    }

    // 6) fallback: SKU-total write to workspace-default location
    const { data: level } = await supabase
      .from("warehouse_inventory_levels")
      .select("available")
      .eq("variant_id", v.id)
      .maybeSingle();
    const total = level?.available ?? 0;

    const claim = await beginExternalSync(supabase, {
      system: "shipstation_v2",
      correlation_id: correlationId,
      sku,
      action: "modify",
      request_body: { quantity: total, location_id: ws.shipstation_v2_inventory_location_id, reason },
    });
    if (!claim.acquired) return { status: "skipped_ledger_duplicate" as const };

    try {
      if (total === 0) {
        await adjustInventoryV2({
          sku,
          inventory_warehouse_id: ws.shipstation_v2_inventory_warehouse_id,
          inventory_location_id: ws.shipstation_v2_inventory_location_id,
          transaction_type: "adjust",
          quantity: 0,
          reason,
        });
      } else {
        await adjustInventoryV2({
          sku,
          inventory_warehouse_id: ws.shipstation_v2_inventory_warehouse_id,
          inventory_location_id: ws.shipstation_v2_inventory_location_id,
          transaction_type: "modify",
          new_available: total,
          reason,
        });
      }
      await markExternalSyncSuccess(supabase, claim.id);
      return { status: "ok_fallback" as const, total };
    } catch (err) {
      await markExternalSyncError(supabase, claim.id, err);
      throw err;
    }
  },
});
```

## C.6. `src/actions/megaplan-spot-check.ts`

```typescript
"use server";
import { tasks } from "@trigger.dev/sdk";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { requireStaff } from "@/lib/server/auth-helpers";

export async function triggerSpotCheck(): Promise<{ runHandleId: string }> {
  await requireStaff();
  const handle = await tasks.trigger("megaplan-spot-check", {});
  return { runHandleId: handle.id };
}

export async function listSpotCheckRuns(limit = 50) {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("megaplan_spot_check_runs")
    .select("id, started_at, finished_at, sampled_sku_count, drift_agreed_count, drift_minor_count, drift_major_count, delayed_propagation_count")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getSpotCheckArtifact(runId: string) {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("megaplan_spot_check_runs")
    .select("artifact_md, summary_json, started_at, finished_at")
    .eq("id", runId)
    .single();
  if (error) throw error;
  return data;
}
```

## C.7. `src/actions/locations.ts`

```typescript
"use server";
import {
  createInventoryLocation,
  updateInventoryLocation,
} from "@/lib/clients/shipstation-inventory-v2";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { requireStaff } from "@/lib/server/auth-helpers";

export async function listLocations(filters: { activeOnly?: boolean; search?: string } = {}) {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  let q = supabase.from("warehouse_locations").select("*").order("name");
  if (filters.activeOnly) q = q.eq("is_active", true);
  if (filters.search) q = q.ilike("name", `%${filters.search}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function createLocation(params: { name: string; type: string; barcode?: string }) {
  const { userId, workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  // 1) local insert
  const { data: row, error } = await supabase
    .from("warehouse_locations")
    .insert({ workspace_id: workspaceId, name: params.name, type: params.type, barcode: params.barcode ?? null, is_active: true })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("LOCATION_ALREADY_EXISTS");
    throw error;
  }

  // 2) ShipStation mirror
  const { data: ws } = await supabase
    .from("workspaces")
    .select("shipstation_v2_inventory_warehouse_id")
    .eq("id", workspaceId)
    .single();
  const warehouseId = ws?.shipstation_v2_inventory_warehouse_id;
  if (!warehouseId) {
    return { ok: true, row, warning: "no_v2_warehouse_configured" as const };
  }

  try {
    const ssLoc = await createInventoryLocation({ inventory_warehouse_id: warehouseId, name: params.name });
    await supabase
      .from("warehouse_locations")
      .update({
        shipstation_inventory_location_id: ssLoc.inventory_location_id,
        shipstation_synced_at: new Date().toISOString(),
        shipstation_sync_error: null,
      })
      .eq("id", row.id);
    return { ok: true, row: { ...row, shipstation_inventory_location_id: ssLoc.inventory_location_id }, warning: null };
  } catch (err) {
    // Hardened per OQ-1 (review pass 2026-04-19): if ShipStation rejects with 409
    // (name already exists in warehouse) — likely from prior stale data we are
    // intentionally letting atrophy — resolve to the existing ID via list lookup
    // and store it locally. This makes our app's create idempotent against
    // any pre-existing ShipStation location with the same name.
    const msg = err instanceof Error ? err.message : String(err);
    const isConflict =
      /409|already exists|duplicate|conflict/i.test(msg) ||
      (err as { status?: number } | null)?.status === 409;
    if (isConflict) {
      try {
        const { listInventoryLocations } = await import("@/lib/clients/shipstation-inventory-v2");
        // Existing client signature: listInventoryLocations(inventoryWarehouseId).
        // Returns ~50 locations max for our warehouse — filter in JS.
        const existing = await listInventoryLocations(warehouseId);
        const match = existing.find((l) => l.name === params.name);
        if (match) {
          await supabase
            .from("warehouse_locations")
            .update({
              shipstation_inventory_location_id: match.inventory_location_id,
              shipstation_synced_at: new Date().toISOString(),
              shipstation_sync_error: null,
            })
            .eq("id", row.id);
          return {
            ok: true,
            row: { ...row, shipstation_inventory_location_id: match.inventory_location_id },
            warning: "shipstation_mirror_resolved_existing" as const,
          };
        }
      } catch (lookupErr) {
        // fall through to error path
      }
    }
    await supabase
      .from("warehouse_locations")
      .update({ shipstation_sync_error: msg })
      .eq("id", row.id);
    return { ok: true, row, warning: "shipstation_mirror_failed" as const, error: msg };
  }
}

// Inline-vs-Trigger threshold (review pass v5 hardening — Vercel timeout fix).
// At 300ms throttle, 30 entries × 300ms = 9s sleep + ~3s API latency = ~12s,
// safely under the Vercel 15s baseline Server Action timeout. Larger ranges
// route to the bulk-create-locations Trigger task (Appendix C.17), which has
// no execution-time ceiling and runs serialized through shipstationQueue.
const RANGE_INLINE_MAX = 30;

export async function createLocationRange(params: {
  prefix: string;
  fromIndex: number;
  toIndex: number;
  type: string;
  padWidth?: number;
  throttleMs?: number; // default 300ms; review pass v5 bumped from 250ms for safety margin
}) {
  await requireStaff();
  const size = params.toIndex - params.fromIndex + 1;
  if (size <= 0) throw new Error("EMPTY_RANGE");

  // Trigger-task path for large ranges
  if (size > RANGE_INLINE_MAX) {
    const handle = await tasks.trigger("bulk-create-locations", {
      prefix: params.prefix,
      fromIndex: params.fromIndex,
      toIndex: params.toIndex,
      type: params.type,
      padWidth: params.padWidth,
      throttleMs: params.throttleMs ?? 300,
    });
    return {
      mode: "trigger" as const,
      taskRunId: handle.id,
      size,
      message: `Range of ${size} exceeds inline cap (${RANGE_INLINE_MAX}). Tracking via task ${handle.id}.`,
    };
  }

  // Inline path for small ranges (≤30)
  const results: Array<{ name: string; status: "created" | "exists" | "error"; warning?: string }> = [];
  const pad = params.padWidth ?? 0;
  const throttle = params.throttleMs ?? 300;
  // 300ms × 30 = 9s sleep budget. Plus per-call API latency (~50-100ms) keeps
  // us under Vercel's default Server Action timeout. Sequential await also
  // enforces serialization. Note: the throttle assumes location-create traffic
  // shares the v2 200 req/min bucket with shipstationQueue inventory writes;
  // 300ms (~3.3 req/sec from this caller) leaves ~80% of budget for fanout.
  for (let i = params.fromIndex; i <= params.toIndex; i++) {
    const name = `${params.prefix}${pad > 0 ? String(i).padStart(pad, "0") : i}`;
    try {
      const r = await createLocation({ name, type: params.type });
      results.push({ name, status: "created", warning: r.warning ?? undefined });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      results.push({ name, status: m === "LOCATION_ALREADY_EXISTS" ? "exists" : "error" });
    }
    if (throttle > 0 && i < params.toIndex) {
      await new Promise((resolve) => setTimeout(resolve, throttle));
    }
  }
  return { mode: "inline" as const, results, size };
}

export async function updateLocation(
  id: string,
  patch: { name?: string; type?: string; barcode?: string | null; isActive?: boolean },
) {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data: existing } = await supabase
    .from("warehouse_locations")
    .select("name, shipstation_inventory_location_id")
    .eq("id", id)
    .single();
  if (!existing) throw new Error("NOT_FOUND");

  // Hardening (review pass v4 §4.1): for renames that have a ShipStation
  // mirror, call ShipStation FIRST. If it fails, do NOT update the local row —
  // otherwise our app's name diverges from ShipStation's. Non-name patches
  // (type, barcode, isActive) update locally without ShipStation involvement.
  const isRenameWithMirror = patch.name !== undefined && existing.shipstation_inventory_location_id;
  if (isRenameWithMirror) {
    try {
      await updateInventoryLocation(existing.shipstation_inventory_location_id!, { name: patch.name! });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase.from("warehouse_locations").update({ shipstation_sync_error: msg }).eq("id", id);
      return { ok: false, warning: "shipstation_mirror_failed" as const, error: msg };
    }
  }

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.type !== undefined) update.type = patch.type;
  if (patch.barcode !== undefined) update.barcode = patch.barcode;
  if (patch.isActive !== undefined) update.is_active = patch.isActive;
  if (isRenameWithMirror) {
    update.shipstation_synced_at = new Date().toISOString();
    update.shipstation_sync_error = null;
  }

  const { error } = await supabase.from("warehouse_locations").update(update).eq("id", id);
  if (error) {
    // Local update failed AFTER ShipStation succeeded. Surface to operator —
    // they need to retry the local update. Rare but logged.
    return {
      ok: false,
      warning: "local_update_failed_after_shipstation" as const,
      error: error.message,
    };
  }
  return { ok: true, warning: null };
}

export async function deactivateLocation(id: string) {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { count } = await supabase
    .from("warehouse_variant_locations")
    .select("variant_id", { count: "exact", head: true })
    .eq("location_id", id)
    .gt("quantity", 0);
  if ((count ?? 0) > 0) throw new Error("LOCATION_HAS_INVENTORY");
  const { error } = await supabase.from("warehouse_locations").update({ is_active: false }).eq("id", id);
  if (error) throw error;
  return { ok: true };
}

export async function retryShipstationLocationSync(locationId: string) {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data: row } = await supabase.from("warehouse_locations").select("name, shipstation_inventory_location_id").eq("id", locationId).single();
  if (!row) throw new Error("NOT_FOUND");
  if (row.shipstation_inventory_location_id) return { ok: true, alreadySynced: true };

  const { data: ws } = await supabase
    .from("workspaces")
    .select("shipstation_v2_inventory_warehouse_id")
    .eq("id", workspaceId)
    .single();
  if (!ws?.shipstation_v2_inventory_warehouse_id) throw new Error("NO_V2_WAREHOUSE");

  try {
    const ssLoc = await createInventoryLocation({ inventory_warehouse_id: ws.shipstation_v2_inventory_warehouse_id, name: row.name });
    await supabase
      .from("warehouse_locations")
      .update({
        shipstation_inventory_location_id: ssLoc.inventory_location_id,
        shipstation_synced_at: new Date().toISOString(),
        shipstation_sync_error: null,
      })
      .eq("id", locationId);
    return { ok: true, alreadySynced: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from("warehouse_locations").update({ shipstation_sync_error: msg }).eq("id", locationId);
    return { ok: false, error: msg };
  }
}
```

## C.8. `src/actions/inventory-counts.ts`

```typescript
"use server";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import { requireStaff } from "@/lib/server/auth-helpers";

export async function startCountSession(sku: string) {
  const { userId, workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();
  // Read current available BEFORE the update so we can snapshot it.
  // Two-step instead of one — we tolerate a tiny race here because the
  // alternative (a single PL/pgSQL function) is overkill for ~Tuesday-deadline scope.
  const { data: pre } = await supabase
    .from("warehouse_inventory_levels")
    .select("available, count_status")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .single();
  if (!pre) throw new Error("UNKNOWN_SKU");
  if (pre.count_status !== "idle") {
    const existing = await getCountSessionState(sku);
    throw new Error(`ALREADY_IN_PROGRESS:${existing.startedBy?.id ?? "unknown"}`);
  }
  const { data, error } = await supabase
    .from("warehouse_inventory_levels")
    .update({
      count_status: "count_in_progress",
      count_started_at: new Date().toISOString(),
      count_started_by: userId,
      // SNAPSHOT — completeCountSession() uses this, not live `available`.
      // Prevents a sale that lands during the count from being attributed to it.
      count_baseline_available: pre.available,
    })
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .eq("count_status", "idle") // optimistic concurrency guard
    .select("count_started_at, count_baseline_available")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const existing = await getCountSessionState(sku);
    throw new Error(`ALREADY_IN_PROGRESS:${existing.startedBy?.id ?? "unknown"}`);
  }
  return { ok: true, startedAt: data.count_started_at, baselineAvailable: data.count_baseline_available };
}

export async function setVariantLocationQuantity(params: {
  sku: string;
  locationId: string;
  quantity: number;
}) {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", params.sku)
    .single();
  if (!variant) throw new Error("UNKNOWN_SKU");

  const { data: level } = await supabase
    .from("warehouse_inventory_levels")
    .select("count_status, available")
    .eq("variant_id", variant.id)
    .single();

  // Upsert per-location row
  await supabase.from("warehouse_variant_locations").upsert(
    { variant_id: variant.id, location_id: params.locationId, quantity: params.quantity, updated_at: new Date().toISOString() },
    { onConflict: "variant_id,location_id" },
  );

  // R-23 sticky flag: first non-zero per-location write switches the SKU
  // permanently into per-location mode. Once true, never reset (prevents
  // ShipStation v2 fanout from falling back to single SKU-total writes which
  // would overwrite per-location records).
  if (params.quantity > 0) {
    await supabase
      .from("warehouse_inventory_levels")
      .update({ has_per_location_data: true })
      .eq("variant_id", variant.id)
      .eq("has_per_location_data", false);
  }

  if (level?.count_status === "count_in_progress") {
    // SUPPRESS fanout — only sum for UI display
    const { data: rows } = await supabase
      .from("warehouse_variant_locations")
      .select("quantity")
      .eq("variant_id", variant.id);
    const sum = (rows ?? []).reduce((acc: number, r: any) => acc + (r.quantity ?? 0), 0);
    return { status: "session_partial" as const, sumOfLocations: sum };
  }

  // idle: recompute total and route through recordInventoryChange
  const { data: rows } = await supabase
    .from("warehouse_variant_locations")
    .select("quantity")
    .eq("variant_id", variant.id);
  const newTotal = (rows ?? []).reduce((acc: number, r: any) => acc + (r.quantity ?? 0), 0);
  const oldTotal = level?.available ?? 0;
  const delta = newTotal - oldTotal;
  if (delta !== 0) {
    await recordInventoryChange({
      workspaceId,
      sku: params.sku,
      delta,
      source: "manual_inventory_count",
      correlationId: `loc-edit:${params.locationId}:${params.sku}:${Date.now()}`,
    });
  }
  return { status: "fanned_out" as const, newTotal };
}

export async function completeCountSession(sku: string) {
  const { workspaceId, userId } = await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .single();
  if (!variant) throw new Error("UNKNOWN_SKU");

  const { data: level } = await supabase
    .from("warehouse_inventory_levels")
    .select("available, count_status, count_started_at, count_baseline_available")
    .eq("variant_id", variant.id)
    .single();
  if (level?.count_status !== "count_in_progress") throw new Error("NO_ACTIVE_SESSION");

  const { data: rows } = await supabase
    .from("warehouse_variant_locations")
    .select("quantity")
    .eq("variant_id", variant.id);
  const sumOfLocations = (rows ?? []).reduce((acc: number, r: any) => acc + (r.quantity ?? 0), 0);

  // CRITICAL FORMULA CHOICE — review pass 2026-04-19 corrected this from baseline to current.
  //
  // Why current (level.available) and not baseline (count_baseline_available)?
  //
  // Scenario A (typical: staff count POST-sale): pre-session available=10, sale lands
  //   → available=9, staff physically counts 9, sumOfLocations=9.
  //   Using current: delta = 9-9 = 0 → available stays 9 ✓
  //   Using baseline: delta = 9-10 = -1 → available drops to 8 ✗ (double-decrements sale)
  //
  // Scenario B (rare: staff count PRE-sale): staff counts 10 first, then sale lands
  //   → available=9, sumOfLocations=10.
  //   Using current: delta = 10-9 = 1 → available rises to 10 ✗ (ignores sale)
  //   Using baseline: delta = 10-10 = 0 → available stays 9 ✓
  //
  // No formula is universally correct without per-bin sale routing (deferred).
  // We pick CURRENT because:
  //   1. Scenario A is far more common (operator guidance §27.3: count during low-shipping
  //      windows; staff naturally count what's physically in the bin RIGHT NOW).
  //   2. Scenario B's failure mode (overcount → oversell) is worse than Scenario A's
  //      failure mode if reversed (undercount → out-of-stock display, no oversell).
  //   3. Scenario B is detectable: spot-check sees count > pre-session-available + sales,
  //      flags drift_minor for next-cycle review.
  //
  // The baseline column is RETAINED for audit traceability — every cycle_count activity
  // row records both baseline and current so operators can post-hoc detect "sales happened
  // during this session" cases.
  const baseline = level.count_baseline_available;
  const currentAvailable = level.available ?? 0;
  const delta = sumOfLocations - currentAvailable;
  const salesDuringSession = baseline != null ? baseline - currentAvailable : null;

  if (delta !== 0) {
    await recordInventoryChange({
      workspaceId,
      sku,
      delta,
      source: "cycle_count",
      correlationId: `count-session:${level?.count_started_at}:${sku}`,
      metadata: {
        actor_user_id: userId,
        sum_of_locations: sumOfLocations,
        baseline_available: baseline,
        current_available_at_complete: currentAvailable,
        sales_during_session: salesDuringSession, // null if baseline missing; >0 means race occurred
        formula_used: "current_minus_sum",
      },
    });
  }

  await supabase
    .from("warehouse_inventory_levels")
    .update({
      count_status: "idle",
      count_started_at: null,
      count_started_by: null,
      count_baseline_available: null,
    })
    .eq("variant_id", variant.id);

  return { newTotal: sumOfLocations, delta, fanoutEnqueued: delta !== 0, baselineUsed: usedBaseline };
}

export async function cancelCountSession(sku: string, opts: { rollbackLocationEntries: boolean }) {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data: variant } = await supabase.from("warehouse_product_variants").select("id").eq("workspace_id", workspaceId).eq("sku", sku).single();
  if (!variant) throw new Error("UNKNOWN_SKU");
  const { data: level } = await supabase.from("warehouse_inventory_levels").select("count_started_at, count_status").eq("variant_id", variant.id).single();
  if (level?.count_status !== "count_in_progress") return { ok: true, alreadyIdle: true };

  if (opts.rollbackLocationEntries && level.count_started_at) {
    await supabase
      .from("warehouse_variant_locations")
      .delete()
      .eq("variant_id", variant.id)
      .gte("updated_at", level.count_started_at);
  }
  await supabase
    .from("warehouse_inventory_levels")
    .update({
      count_status: "idle",
      count_started_at: null,
      count_started_by: null,
      count_baseline_available: null,
    })
    .eq("variant_id", variant.id);
  return { ok: true, alreadyIdle: false };
}

/**
 * Auto-cancel any session in_progress > 24 hr. Called by a daily Trigger cron.
 * Does NOT roll back per-location entries — operator can resume manually if desired.
 * Creates a review queue item for visibility.
 */
export async function autoCancelStaleCountSessions() {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: stale } = await supabase
    .from("warehouse_inventory_levels")
    .select("variant_id, sku, count_started_at, count_started_by")
    .eq("workspace_id", workspaceId)
    .eq("count_status", "count_in_progress")
    .lt("count_started_at", cutoff);
  if (!stale || stale.length === 0) return { cancelled: 0 };

  for (const row of stale) {
    await supabase
      .from("warehouse_inventory_levels")
      .update({
        count_status: "idle",
        count_started_at: null,
        count_started_by: null,
        count_baseline_available: null,
      })
      .eq("variant_id", row.variant_id);
    await supabase.from("warehouse_review_queue").upsert(
      {
        workspace_id: workspaceId,
        severity: "medium",
        group_key: "stale-count-session",
        correlation_id: `stale-count:${row.sku}:${row.count_started_at}`,
        title: `Auto-cancelled stale count session for ${row.sku}`,
        context: {
          sku: row.sku,
          started_at: row.count_started_at,
          started_by: row.count_started_by,
          note: "Per-location entries preserved. Restart count to push final total.",
        },
      },
      { onConflict: "correlation_id" },
    );
  }
  return { cancelled: stale.length };
}

export async function getCountSessionState(sku: string) {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data: variant } = await supabase.from("warehouse_product_variants").select("id").eq("workspace_id", workspaceId).eq("sku", sku).single();
  if (!variant) throw new Error("UNKNOWN_SKU");

  const { data: level } = await supabase
    .from("warehouse_inventory_levels")
    .select("available, count_status, count_started_at, users:count_started_by(id, name)")
    .eq("variant_id", variant.id)
    .single();

  const { data: rows } = await supabase
    .from("warehouse_variant_locations")
    .select("location_id, quantity, warehouse_locations!inner(name, type)")
    .eq("variant_id", variant.id);

  const sumOfLocations = (rows ?? []).reduce((acc: number, r: any) => acc + (r.quantity ?? 0), 0);
  return {
    status: level?.count_status ?? "idle",
    startedAt: level?.count_started_at ?? null,
    startedBy: (level?.users as any) ?? null,
    sumOfLocations,
    currentAvailable: level?.available ?? 0,
    locationEntries: rows ?? [],
  };
}
```

## C.9. `src/app/admin/settings/megaplan-verification/page.tsx` (skeleton)

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppQuery, useAppMutation } from "@/lib/hooks/use-app-query";
import { triggerSpotCheck, listSpotCheckRuns, getSpotCheckArtifact } from "@/actions/megaplan-spot-check";

export default function MegaplanVerificationPage() {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const { data: runs, refetch } = useAppQuery({
    queryKey: ["megaplan-spot-check-runs"],
    queryFn: () => listSpotCheckRuns(50),
  });
  const { data: artifact } = useAppQuery({
    queryKey: ["megaplan-spot-check-artifact", openRunId ?? ""],
    queryFn: () => getSpotCheckArtifact(openRunId!),
    enabled: !!openRunId,
  });
  const trigger = useAppMutation({ mutationFn: triggerSpotCheck, onSuccess: () => refetch() });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Megaplan verification</h1>
        <Button onClick={() => trigger.mutate(undefined)} disabled={trigger.isPending}>
          {trigger.isPending ? "Triggering..." : "Run spot-check now"}
        </Button>
      </div>
      <a href="/docs/MEGA_PLAN_VERIFICATION_2026-04-13.md" className="text-blue-600 underline text-sm">
        View signed verification artifact (Sections A–E)
      </a>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">SKUs</TableHead>
            <TableHead className="text-right">Agreed</TableHead>
            <TableHead className="text-right">Delayed</TableHead>
            <TableHead className="text-right">Minor</TableHead>
            <TableHead className="text-right">Major</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(runs ?? []).map((r) => (
            <TableRow key={r.id}>
              <TableCell>{new Date(r.started_at).toLocaleString()}</TableCell>
              <TableCell className="text-right font-mono">{r.sampled_sku_count}</TableCell>
              <TableCell className="text-right font-mono">{r.drift_agreed_count}</TableCell>
              <TableCell className="text-right font-mono">{r.delayed_propagation_count}</TableCell>
              <TableCell className="text-right font-mono">{r.drift_minor_count}</TableCell>
              <TableCell className={`text-right font-mono ${r.drift_major_count > 0 ? "text-red-600 font-bold" : ""}`}>
                {r.drift_major_count}
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="sm" onClick={() => setOpenRunId(r.id)}>View</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Dialog open={!!openRunId} onOpenChange={(o) => !o && setOpenRunId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Spot-check artifact</DialogTitle></DialogHeader>
          <pre className="text-xs whitespace-pre-wrap">{artifact?.artifact_md ?? "Loading..."}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

## C.10. `src/app/admin/settings/locations/page.tsx` (skeleton)

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useAppQuery, useAppMutation } from "@/lib/hooks/use-app-query";
import {
  listLocations, createLocation, createLocationRange,
  updateLocation, deactivateLocation, retryShipstationLocationSync,
} from "@/actions/locations";

export default function LocationsPage() {
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showRange, setShowRange] = useState(false);

  const { data: locations, refetch } = useAppQuery({
    queryKey: ["locations", { search, activeOnly }],
    queryFn: () => listLocations({ search: search || undefined, activeOnly }),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Warehouse locations</h1>
        <div className="flex gap-2">
          <Button onClick={() => setShowCreate(true)}>Add location</Button>
          <Button variant="outline" onClick={() => setShowRange(true)}>Add range</Button>
        </div>
      </div>
      <div className="flex gap-3">
        <Input placeholder="Search name..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-64" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active only
        </label>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead><TableHead>Type</TableHead>
            <TableHead>Barcode</TableHead><TableHead>Active</TableHead>
            <TableHead>ShipStation sync</TableHead><TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(locations ?? []).map((loc: any) => (
            <TableRow key={loc.id}>
              <TableCell className="font-mono">{loc.name}</TableCell>
              <TableCell>{loc.type}</TableCell>
              <TableCell className="font-mono text-xs">{loc.barcode ?? "—"}</TableCell>
              <TableCell>{loc.is_active ? "Yes" : "No"}</TableCell>
              <TableCell>
                {loc.shipstation_inventory_location_id ? <Badge variant="secondary">Synced</Badge>
                  : loc.shipstation_sync_error ? <Badge variant="destructive">Error</Badge>
                  : <Badge variant="outline">Pending</Badge>}
              </TableCell>
              <TableCell>
                {loc.shipstation_sync_error && (
                  <Button size="sm" variant="outline" onClick={() => retryShipstationLocationSync(loc.id).then(() => refetch())}>
                    Retry
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {/* Create + Range dialogs omitted for brevity — standard form patterns */}
    </div>
  );
}
```

## C.11. ShipStation v2 client extensions (additions to `src/lib/clients/shipstation-inventory-v2.ts`)

```typescript
// Add to the bottom of shipstation-inventory-v2.ts, before the EXPLICITLY NOT EXPORTED footer.

interface V2InventoryLocationCreateBody {
  inventory_warehouse_id: string;
  name: string;
}

interface V2InventoryLocationUpdateBody {
  name?: string;
}

/**
 * Create a new inventory location in ShipStation v2.
 * Mirrored from createLocation() Server Action when staff create a location in our app.
 */
export async function createInventoryLocation(
  body: V2InventoryLocationCreateBody,
): Promise<V2InventoryLocation> {
  const json = await v2Fetch<Record<string, unknown>>("/v2/inventory_locations", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    inventory_location_id: (json.inventory_location_id as string | undefined) ?? (json.location_id as string),
    inventory_warehouse_id: (json.inventory_warehouse_id as string | undefined) ?? body.inventory_warehouse_id,
    name: (json.name as string | undefined) ?? body.name,
  };
}

/**
 * Update an inventory location (rename) in ShipStation v2.
 * Called by updateLocation() Server Action on rename.
 */
export async function updateInventoryLocation(
  inventoryLocationId: string,
  body: V2InventoryLocationUpdateBody,
): Promise<V2InventoryLocation> {
  const json = await v2Fetch<Record<string, unknown>>(`/v2/inventory_locations/${inventoryLocationId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return {
    inventory_location_id: (json.inventory_location_id as string | undefined) ?? inventoryLocationId,
    inventory_warehouse_id: json.inventory_warehouse_id as string,
    name: (json.name as string | undefined) ?? null,
  };
}

/**
 * Delete an inventory location in ShipStation v2.
 * Defined for future cleanup tooling. NOT auto-called by deactivateLocation().
 */
export async function deleteInventoryLocation(inventoryLocationId: string): Promise<void> {
  await v2Fetch<unknown>(`/v2/inventory_locations/${inventoryLocationId}`, { method: "DELETE" });
}
```

## C.12. `src/lib/server/inventory-fanout.ts` extension diff

**Status: SHIPPED 2026-04-13 (audit fix F1).** The actual landed implementation differs from the C.12 sketch below in two ways: (1) the task name is `shipstation-v2-adjust-on-sku` (not `-sync-on-sku`) — handles BOTH delta directions; (2) the source-aware echo skip (Rule #65, for `'shipstation'` and `'reconcile'` sources) wraps the enqueue. See `src/lib/server/inventory-fanout.ts` for the live form. The block below is preserved as the original plan sketch.

Insert the following block in `fanoutInventoryChange()` AFTER the Bandcamp fanout (around line 142, before the bundle-parent recursion):

```typescript
// 4th target: ShipStation v2 per-SKU push (Phase 4b).
// Bundles are excluded by the task itself (Phase 2.5 (a)).
if (variant && guard.shouldFanout("shipstation", effectiveCorrelationId)) {
  try {
    await Sentry.startSpan(
      {
        name: "inventory.fanout.shipstation_v2",
        op: "fanout.shipstation_v2",
        attributes: { "fanout.sku": sku },
      },
      () =>
        tasks.trigger("shipstation-v2-sync-on-sku", {
          workspaceId,
          sku,
          correlationId: effectiveCorrelationId,
          reason: "fanout_inventory_change",
        }),
    );
  } catch {
    /* non-critical — reconcile sensor catches drift */
  }
}
```

The `FanoutResult` interface gains a `shipstationEnqueued: boolean` field. (Shipped form: `shipstationV2Enqueued: boolean`.)

## C.13. `src/app/admin/inventory/page.tsx` count session UI patch

The expanded detail row (currently lines 346-419 of the file in Appendix B.8) gains a count session panel above the existing Locations panel. Patch shape:

```tsx
{/* Count session panel — NEW — renders above existing Locations panel */}
<div className="col-span-2 mb-4 rounded border bg-card p-4">
  {sessionState.status === "idle" ? (
    <div className="flex items-center justify-between">
      <div>
        <h4 className="text-sm font-semibold">Count session</h4>
        <p className="text-muted-foreground text-xs">Per-bin counting. External fanout suppressed until you click Complete.</p>
      </div>
      <Button onClick={() => startCountMutation.mutate(row.sku)}>Start count</Button>
    </div>
  ) : (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Badge variant="secondary">
          Count in progress — started {formatDistanceToNow(sessionState.startedAt!)} ago by {sessionState.startedBy?.name}
        </Badge>
        <span className="font-mono text-sm">Sum so far: {sessionState.sumOfLocations}</span>
      </div>
      <ul className="space-y-1">
        {sessionState.locationEntries.map((entry) => (
          <li key={entry.location_id} className="flex items-center gap-3">
            <span className="flex-1 font-mono text-sm">{entry.warehouse_locations.name}</span>
            <EditableNumberCell
              value={entry.quantity}
              onSave={(n) => setLocQtyMutation.mutate({ sku: row.sku, locationId: entry.location_id, quantity: n ?? 0 })}
            />
          </li>
        ))}
        <li>
          <LocationTypeahead
            placeholder="+ Add location (search or type new name)"
            onSelect={(loc) => setLocQtyMutation.mutate({ sku: row.sku, locationId: loc.id, quantity: 0 })}
            onCreateNew={async (name) => {
              const r = await createLocation({ name, type: "shelf" });
              setLocQtyMutation.mutate({ sku: row.sku, locationId: r.row.id, quantity: 0 });
            }}
          />
        </li>
      </ul>
      <div className="flex gap-2">
        <Button onClick={() => completeCountMutation.mutate(row.sku)}>Complete count</Button>
        <Button variant="outline" onClick={() => setShowCancelDialog(true)}>Cancel count</Button>
      </div>
    </div>
  )}
</div>
```

While `sessionState.status === 'count_in_progress'`, the parent row's Avail cell renders `(count in progress — sum so far: {sumOfLocations})` and is read-only.

Also adds toast feedback (Sonner) wrapping the existing `adjustInventory()` calls; and a daily count-progress chip near the Export CSV button driven by `getTodayCountProgress()`.

## C.14. `src/actions/inventory.ts` patch — `getTodayCountProgress`

```typescript
export async function getTodayCountProgress(): Promise<{ totalChangesToday: number; totalChangesByMe: number }> {
  const { userId, workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const startIso = startOfDay.toISOString();

  const { count: totalChangesToday } = await supabase
    .from("warehouse_inventory_activity")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gte("created_at", startIso)
    .in("source", ["manual", "cycle_count", "manual_inventory_count"]);

  const { count: totalChangesByMe } = await supabase
    .from("warehouse_inventory_activity")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gte("created_at", startIso)
    .in("source", ["manual", "cycle_count", "manual_inventory_count"])
    .eq("actor_user_id", userId);

  return { totalChangesToday: totalChangesToday ?? 0, totalChangesByMe: totalChangesByMe ?? 0 };
}
```

## C.15. `docs/DEFERRED_FOLLOWUPS.md` initial file

```markdown
---
- slug: phase-7-dormant-cleanup
  title: "Phase 7: dormant client-store code cleanup"
  due_date: 2026-07-13
  severity: medium
  context: "90-day dormancy review of client-store webhook + multi-store push code paths."
- slug: tier1-9-better-stack
  title: "Tier 1 #9: Better Stack synthetic monitoring"
  due_date: 2026-05-13
  severity: high
  context: "30-day waiver expiration. Required before sustained 100% rollout."
- slug: tier1-10-statuspage
  title: "Tier 1 #10: statuspage.io public status page"
  due_date: 2026-05-13
  severity: high
  context: "30-day waiver expiration. Required for client-facing incident comms."
- slug: external-sync-events-retention
  title: "external_sync_events retention cron verification"
  due_date: 2026-04-25
  severity: low
  context: "Confirm 7-day retention is firing weekly via Trigger.dev dashboard."
- slug: shipstation-stale-location-cleanup
  title: "Stale ShipStation v2 location cleanup"
  due_date: 2026-05-21
  severity: low
  context: "After 30 days of atrophy, review remaining stale locations and either ship a Delete UI or run manual cleanup."
---

# Deferred follow-ups registry

This file is parsed by the daily `deferred-followups-reminder` Trigger task.
Each entry's `due_date` triggers a `warehouse_review_queue` item.
```

## C.16. `docs/MEGA_PLAN_VERIFICATION_2026-04-13.md` skeleton

```markdown
# Mega-plan verification artifact — 2026-04-13

## Section A — Automated gate results (Sat ~22:00)

- pnpm typecheck: ___PASS / FAIL___
- pnpm test: ___N tests passed / N failed___
- pnpm check (Biome): ___PASS / FAIL___
- pnpm build: ___PASS / FAIL___
- pnpm release:gate: ___PASS / FAIL___
- supabase migration list --linked: migrations 40 + 50 applied: ___YES / NO___

## Section B — Phase 4/5/6 closeout summaries (auto-filled from mega-plan §14.9)

[Pre-filled by agent]

## Section C — Deferred items (auto-filled from `DEFERRED_FOLLOWUPS.md`)

[Pre-filled by agent]

## Section D — Tier 1 hardening status (auto-filled)

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Per-integration kill switches | DONE | shipstation_sync_paused (50), bandcamp_sync_paused (10), clandestine_shopify_sync_paused (10), client_store_sync_paused (10) |
| 9 | Better Stack synthetic monitoring | WAIVED 30 days (due 2026-05-13) | |
| 10 | statuspage.io public status page | WAIVED 30 days (due 2026-05-13) | |
| 13 | Percentage rollouts | DONE | fanout_rollout_percent (10) |

## Section E — Operator signoff (Mon ~17:00)

**Ramp evidence:**
- Sun 12:00: 0% → 10%, run ID: ___
- Sun 16:00: 10% → 50%, run ID: ___
- Mon 09:00: 50% → 100%, run ID: ___

**Spot-check evidence (final 24 hours):** ___run IDs___

**UX dry run results:**
- Run #1 (Sun 10:00): Part A ___PASS / FAIL___, Part B ___PASS / FAIL___
- Run #2 (Mon 14:00): per-shelf time ___min, per-SKU avg ___s

**Tier 1 #9 + #10 waiver text:** "Better Stack and statuspage.io are deferred to 2026-05-13. Acceptance: agreed risk to onboard staff Tue Apr 21 with manual operator monitoring during the first week. Ramp to 100% authorized despite open waivers."

**Operator signature:** _______________  **Date:** ___________
```

---

## C.17. `src/trigger/tasks/bulk-create-locations.ts` (Vercel timeout offload)

Added in review pass v5. The Server Action `createLocationRange` routes ranges of >30 to this task to avoid Vercel's Server Action timeout. The task uses `shipstationQueue` so it's serialized against fanout traffic and respects the 200 req/min ShipStation v2 ceiling.

```typescript
import { task, logger } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";
import { createInventoryLocation } from "@/lib/clients/shipstation-inventory-v2";

export const bulkCreateLocationsTask = task({
  id: "bulk-create-locations",
  queue: shipstationQueue, // serialize with all other ShipStation v2 traffic
  maxDuration: 600, // 10 min — well above any practical range size
  run: async (payload: {
    workspaceId: string;
    actorUserId: string;
    prefix: string;
    fromIndex: number;
    toIndex: number;
    type: string;
    padWidth?: number;
    throttleMs: number;
  }) => {
    const supabase = createServiceRoleClient();
    const { data: ws } = await supabase
      .from("workspaces")
      .select("shipstation_v2_inventory_warehouse_id, shipstation_sync_paused")
      .eq("id", payload.workspaceId)
      .single();
    if (!ws?.shipstation_v2_inventory_warehouse_id) {
      throw new Error("NO_V2_WAREHOUSE");
    }

    const pad = payload.padWidth ?? 0;
    const results: Array<{ name: string; localId?: string; ssId?: string; status: string; error?: string }> = [];

    for (let i = payload.fromIndex; i <= payload.toIndex; i++) {
      const name = `${payload.prefix}${pad > 0 ? String(i).padStart(pad, "0") : i}`;

      // 1) Insert local row (idempotent — UNIQUE(workspace_id, name) catches duplicates)
      const { data: row, error: insErr } = await supabase
        .from("warehouse_locations")
        .insert({ workspace_id: payload.workspaceId, name, type: payload.type, is_active: true, created_by: payload.actorUserId })
        .select("id")
        .single();
      if (insErr) {
        const isDup = /duplicate|unique/i.test(insErr.message);
        results.push({ name, status: isDup ? "exists" : "local_error", error: insErr.message });
        continue;
      }

      // 2) Mirror to ShipStation v2 (skip if kill switch flipped mid-run)
      if (ws.shipstation_sync_paused) {
        results.push({ name, localId: row.id, status: "local_ok_ss_paused" });
      } else {
        try {
          const ssLoc = await createInventoryLocation({
            inventory_warehouse_id: ws.shipstation_v2_inventory_warehouse_id,
            name,
          });
          await supabase
            .from("warehouse_locations")
            .update({
              shipstation_inventory_location_id: ssLoc.inventory_location_id,
              shipstation_synced_at: new Date().toISOString(),
              shipstation_sync_error: null,
            })
            .eq("id", row.id);
          results.push({ name, localId: row.id, ssId: ssLoc.inventory_location_id, status: "ok" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // R-22 hardening could be inlined here too; for v5 we surface the error
          // and let `retryShipstationLocationSync` handle 409s manually.
          await supabase
            .from("warehouse_locations")
            .update({ shipstation_sync_error: msg })
            .eq("id", row.id);
          results.push({ name, localId: row.id, status: "ss_error", error: msg });
        }
      }

      // Throttle between iterations to stay under ShipStation 200 req/min ceiling
      if (payload.throttleMs > 0 && i < payload.toIndex) {
        await new Promise((resolve) => setTimeout(resolve, payload.throttleMs));
      }
    }

    const summary = {
      total: results.length,
      ok: results.filter((r) => r.status === "ok").length,
      exists: results.filter((r) => r.status === "exists").length,
      ss_error: results.filter((r) => r.status === "ss_error").length,
      local_error: results.filter((r) => r.status === "local_error").length,
    };

    logger.info("[bulk-create-locations] completed", { summary });

    if (summary.ss_error > 0) {
      await supabase.from("warehouse_review_queue").insert({
        workspace_id: payload.workspaceId,
        severity: "medium",
        group_key: "bulk-create-locations-ss-errors",
        title: `Bulk location create: ${summary.ss_error} ShipStation mirror failures`,
        context: { summary, results: results.filter((r) => r.status === "ss_error") },
      });
    }

    return { summary, results };
  },
});
```

**UI integration:** the Locations admin page (Appendix C.10) checks the response: if `mode === "trigger"`, renders a "Range too large for inline create — running as background task ({taskRunId}). Refresh in ~30s." inline notice. The list refresh picks up new rows as the task inserts them. (Optional Sunday polish: poll task status via existing `useTaskRun` hook.)

---

# Appendix D — Schema reference

## D.1. Full migration list (63 files in `supabase/migrations/`, chronological)

| Filename | One-line description |
|---|---|
| `20260316000001_core.sql` | Core tables: workspaces, users, organizations, roles |
| `20260316000002_products.sql` | warehouse_products, warehouse_product_variants |
| `20260316000003_inventory.sql` | warehouse_inventory_levels, warehouse_locations, warehouse_variant_locations, warehouse_inventory_activity |
| `20260316000004_orders.sql` | warehouse_orders, warehouse_order_items |
| `20260316000005_supporting.sql` | Supporting reference tables |
| `20260316000006_inbound.sql` | Inbound shipments + check-in tables |
| `20260316000007_bandcamp.sql` | bandcamp_product_mappings |
| `20260316000008_monitoring.sql` | sensor_check, sensor_history, channel_sync_log |
| `20260316000009_rls.sql` | RLS policies + is_staff_user / get_user_org_id helpers |
| `20260316000010_support.sql` | support_conversations, support_messages |
| `20260316000011_store_connections.sql` | client_store_connections, client_store_sku_mappings |
| `20260316000012_org_extended.sql` | Extended org metadata |
| `20260318000001_fixes.sql` | Misc constraint fixes |
| `20260318000002_product_images_storage.sql` | Storage bucket policies for product images |
| `20260318000003_billing_client_overrides.sql` | billing_overrides |
| `20260318000004_drop_ship.sql` | drop-ship support |
| `20260318000005_variant_cost.sql` | per-variant cost tracking |
| `20260319000001_support_client_insert.sql` | RLS policy adjustments |
| `20260319000002_org_hierarchy.sql` | org parent_id |
| `20260319000003_organization_aliases.sql` | org name aliases |
| `20260319000004_user_is_active.sql` | users.is_active |
| `20260320000005_support_conversation_client_write_policy_repair.sql` | RLS repair |
| `20260320000006_support_omnichannel_metadata.sql` | omnichannel metadata |
| `20260320000007_users_presence_columns.sql` | online presence |
| `20260320000008_bandcamp_shipment_tracking.sql` | bandcamp_shipment_tracking |
| `20260325000001_v72_schema_updates.sql` | Schema bump for v7.2 |
| `20260328000001_backfill_inventory_org_id.sql` | Trigger derive_inventory_org_id |
| `20260328000002_backfill_street_date_from_mappings.sql` | backfill |
| `20260328000003_mailorder_per_org_dedup.sql` | mailorder dedup |
| `20260329000000_bandcamp_scraper_prereqs.sql` | scraper tables |
| `20260331000001_bandcamp_metadata_fields.sql` | bandcamp metadata |
| `20260401000001_inventory_hardening.sql` | Inventory invariants enforcement |
| `20260401000002_bundle_components.sql` | bundle_components |
| `20260401000003_scraper_hardening.sql` | scraper hardening |
| `20260402000001_shipments_hardening.sql` | shipment invariants |
| `20260402180000_channel_sync_log_metadata.sql` | sync log metadata |
| `20260402190000_scraper_observability.sql` | scraper metrics |
| `20260402200000_scraper_retry_reset.sql` | scraper retry |
| `20260402210000_bandcamp_api_complete.sql` | bandcamp api columns |
| `20260403000001_fix_variant_id_unique.sql` | unique constraint fix |
| `20260404100000_bandcamp_genre_tags.sql` | genre tags |
| `20260407000000_backfill_audit_log.sql` | audit log |
| `20260409000001_inventory_item_id.sql` | shopify_inventory_item_id |
| `20260410000000_product_category.sql` | product category |
| `20260411000000_pirate_ship_storage.sql` | pirate ship storage bucket |
| `20260413000001_pirate_ship_dedup.sql` | pirate ship dedup |
| `20260413000002_pirate_ship_cleanup.sql` | pirate ship cleanup |
| `20260413000003_backfill_label_source.sql` | backfill label source |
| `20260413000004_billing_adjustments_details.sql` | billing adjustments |
| `20260413000005_billing_overrides_rls.sql` | billing overrides RLS |
| `20260413000010_tier1_hardening.sql` | **Tier 1**: per-integration kill switches on workspaces, fanout_rollout_percent, external_sync_events ledger, retention index |
| `20260413000020_phase4_v2_warehouse_defaults.sql` | **Phase 4**: workspaces.shipstation_v2_inventory_warehouse_id + shipstation_v2_inventory_location_id + default_safety_stock |
| `20260413000030_phase5_reconcile_and_sku_sync_status.sql` | **Phase 5**: sku_sync_status view + reconcile schedule columns |
| `20260413100000_backfill_pirate_ship_recent.sql` | recent backfill |
| `20260414000000_scraper_hardening_v2.sql` | scraper v2 |
| `20260414000002_inventory_sync_pause.sql` | inventory_sync_paused (global) on workspaces |
| `20260414100000_url_source_expand.sql` | url source enum expand |
| `20260415000001_backfill_variant_format_names.sql` | format backfill |
| `20260415000002_fix_shipment_source_constraint.sql` | shipment source fix |
| `20260415000003_shipment_item_format_override.sql` | shipment item override |
| `20260417000001_sku_rectify_infrastructure.sql` | **Phase 0.5**: sku_sync_conflicts, sku_remap_history, redis_mutex helpers |
| `20260417000002_bandcamp_baseline_anomaly.sql` | **Phase 1**: bandcamp_baseline_anomalies table + push_mode enum |
| `20260417000003_distro_dormancy.sql` | distro dormancy markers |
| **PROPOSED** `20260413000040_megaplan_spot_check_runs.sql` | **THIS PLAN**: spot-check artifact storage |
| **SHIPPED** `20260418000001_phase4b_megaplan_closeout_and_count_session.sql` (originally proposed as `20260413000050_phase4b_shipstation_fanout.sql`) | **THIS PLAN**: shipstation kill switch + count_status + ShipStation location mirror columns + cycle_count + manual_inventory_count InventorySource values + spot-check schema |

## D.2. Tables touched by this plan (relevant column shape)

### `workspaces` (extended by migration `20260418000001` — planned name `migration 50`)

| Column | Type | Default | Notes |
|---|---|---|---|
| id | uuid | gen_random_uuid() | PK |
| name | text | | |
| inventory_sync_paused | boolean | false | global kill switch (existing 14000002) |
| shipstation_sync_paused | boolean | false | **NEW** per-integration kill switch |
| shipstation_sync_paused_at | timestamptz | null | **NEW** |
| shipstation_sync_paused_by | uuid | null | **NEW** references users(id) |
| shipstation_sync_paused_reason | text | null | **NEW** |
| bandcamp_sync_paused | boolean | false | (Tier 1 hardening 13000010) |
| clandestine_shopify_sync_paused | boolean | false | (Tier 1) |
| client_store_sync_paused | boolean | false | (Tier 1) |
| fanout_rollout_percent | integer | 0 | (Tier 1) |
| shipstation_v2_inventory_warehouse_id | text | null | (Phase 4 13000020) |
| shipstation_v2_inventory_location_id | text | null | (Phase 4) |
| default_safety_stock | integer | 3 | (Phase 4) |

### `warehouse_inventory_levels` (extended by migration `20260418000001` — planned name `migration 50`)

| Column | Type | Default | Notes |
|---|---|---|---|
| variant_id | uuid | | PK + FK |
| workspace_id | uuid | | |
| org_id | uuid | | auto-derived by trigger from variant→product |
| on_hand | integer | 0 | |
| available | integer | 0 | |
| committed | integer | 0 | |
| incoming | integer | 0 | |
| safety_stock | integer | null | per-SKU override (workspace default 3) |
| last_redis_write_at | timestamptz | null | |
| count_status | text | 'idle' | **NEW** check IN ('idle','count_in_progress') |
| count_started_at | timestamptz | null | **NEW** |
| count_started_by | uuid | null | **NEW** references users(id) |

### `warehouse_locations` (extended by migration `20260418000001` — planned name `migration 50`)

| Column | Type | Default | Notes |
|---|---|---|---|
| id | uuid | gen_random_uuid() | PK |
| workspace_id | uuid | | |
| name | text | | UNIQUE(workspace_id, name) |
| type | text | | shelf / bin / floor / staging |
| barcode | text | null | future scanner support |
| is_active | boolean | true | |
| shipstation_inventory_location_id | text | null | **NEW** mirror to ShipStation |
| shipstation_synced_at | timestamptz | null | **NEW** |
| shipstation_sync_error | text | null | **NEW** |

### `warehouse_variant_locations` (existing — no schema change)

| Column | Type | Notes |
|---|---|---|
| variant_id | uuid | PK part 1 |
| location_id | uuid | PK part 2 |
| quantity | integer | per-bin qty |
| updated_at | timestamptz | used by `cancelCountSession({ rollback: true })` |

### `warehouse_inventory_activity` (extended by migration `20260418000001` — planned name `migration 50`)

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| workspace_id | uuid | |
| variant_id | uuid | |
| sku | text | |
| delta | integer | |
| source | text | check IN extended to add `cycle_count`, `manual_inventory_count` |
| correlation_id | text | UNIQUE(sku, correlation_id) |
| metadata | jsonb | |
| actor_user_id | uuid | |
| created_at | timestamptz | |

### `external_sync_events` (existing — no schema change; ledger from Tier 1 hardening)

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| system | text | shipstation_v1 / shipstation_v2 / bandcamp / clandestine_shopify |
| correlation_id | text | |
| sku | text | |
| action | text | increment / decrement / adjust / modify / alias_add / alias_remove / sku_rename |
| status | text | in_flight / success / error |
| request_body | jsonb | |
| response_body | jsonb | |
| created_at | timestamptz | |
| completed_at | timestamptz | |
|  | | UNIQUE(system, correlation_id, sku, action) |

### `megaplan_spot_check_runs` (NEW migration 40)

DDL in §15.1 / Appendix C.1.

### `warehouse_review_queue` (existing — no schema change; receives spot-check + reminder cron items)

Used by Rule #55. Required fields: `assigned_to`, `severity`, `sla_due_at`, `suppressed_until`, `group_key`, `correlation_id`, `occurrence_count`.

---

# Appendix E — API + Trigger catalog touched

## E.1. ShipStation v2 endpoints used

| Endpoint | Method | Wrapper | Used by | Idempotency key |
|---|---|---|---|---|
| `/v2/inventory` | GET | `listInventory({ skus })` | spot-check task, reconcile (existing) | n/a (read) |
| `/v2/inventory_adjustments` | POST | `adjustInventoryV2({ transaction_type: 'increment'\|'decrement', quantity })` | **SHIPPED:** `shipstation-v2-decrement` (sales) + `shipstation-v2-adjust-on-sku` (manual counts + fanout — audit fix F1, 2026-04-13). Phase 0 Patch D2 contract — never `modify`. | `external_sync_events (system='shipstation_v2', correlation_id, sku, action='increment'\|'decrement')` |
| `/v2/inventory_adjustments` | POST | `adjustInventoryV2({ transaction_type: 'modify', new_available })` | **DEFERRED:** per-location rewrite (§3f / §15.3) — would use `shipstation-v2-sync-on-sku` per-location form (Appendix C.5). Not currently called. | `external_sync_events (system='shipstation_v2', correlation_id, sku, action='modify')` |
| `/v2/inventory_adjustments` | POST | `adjustInventoryV2({ transaction_type: 'adjust', quantity: 0 })` | **DEFERRED:** zero-quantity case for the per-location rewrite (Patch D2). Not currently called by shipped paths. | same as above with `action='adjust'` |
| `/v2/inventory_locations` | POST | `createInventoryLocation({ inventory_warehouse_id, name })` | `createLocation()` Server Action | local DB row id (one-shot mirror) |
| `/v2/inventory_locations/{id}` | PUT | `updateInventoryLocation(id, { name })` | `updateLocation()` Server Action when renaming | local DB row id |
| `/v2/inventory_locations/{id}` | DELETE | `deleteInventoryLocation(id)` | DEFINED only — not auto-called this sprint | n/a |

All v2 calls flow through `shipstationQueue` (concurrencyLimit: 1) per Tier 1 hardening.

## E.2. Bandcamp endpoints (no change)

| Endpoint | Wrapper | Used by | Notes |
|---|---|---|---|
| `update_quantities/_/3` | `updateQuantities()` | `bandcamp-push-on-sku` (existing) | OAuth-bearing, serialized via `bandcampQueue` (concurrencyLimit: 1) |
| `update_inventory_amount/_/3` | (legacy) | (deprecated) | not used by new code |

## E.3. Trigger.dev tasks touched

| Task ID | File | Type | Queue | New / Existing | Cron / trigger source |
|---|---|---|---|---|---|
| `shipstation-v2-adjust-on-sku` (planned as `shipstation-v2-sync-on-sku`) | `src/trigger/tasks/shipstation-v2-adjust-on-sku.ts` | task | shipstationQueue | **SHIPPED 2026-04-13** (audit fix F1) | enqueued by `fanoutInventoryChange()` AND by `submitManualInventoryCounts` Server Action |
| `megaplan-spot-check` | `src/trigger/tasks/megaplan-spot-check.ts` | schedules.task | shipstationQueue (read-only) | **NEW** | cron `0 * * * *` Sat-Tue, then `0 9 * * *` |
| `deferred-followups-reminder` | `src/trigger/tasks/deferred-followups-reminder.ts` | schedules.task | (default) | **NEW** | cron `0 9 * * *` |
| `bandcamp-push-on-sku` | `src/trigger/tasks/bandcamp-push-on-sku.ts` | task | bandcampQueue | existing | enqueued by `fanoutInventoryChange()` (no change) |
| `shipstation-v2-decrement` | `src/trigger/tasks/shipstation-v2-decrement.ts` | task | shipstationQueue | existing | enqueued by Bandcamp sale path (no change) |
| `shipstation-bandcamp-reconcile-hot` | (Phase 5) | schedules.task | shipstationQueue | existing | cron `*/5 * * * *` |
| `shipstation-bandcamp-reconcile-warm` | (Phase 5) | schedules.task | shipstationQueue | existing | cron `*/30 * * * *` |
| `shipstation-bandcamp-reconcile-cold` | (Phase 5) | schedules.task | shipstationQueue | existing | cron `0 */6 * * *` |
| `external-sync-events-retention` | (Patch D3) | schedules.task | (default) | existing | cron `0 4 * * 0` (weekly Sun 04:00) |

## E.4. Server Actions touched

| File | Action | New / Existing | Notes |
|---|---|---|---|
| `src/actions/inventory.ts` | `adjustInventory` | existing | now triggers ShipStation fanout via patched `inventory-fanout.ts` (no source code change to action) |
| `src/actions/inventory.ts` | `getTodayCountProgress` | **NEW** | UX polish chip |
| `src/actions/inventory-counts.ts` | `startCountSession`, `setVariantLocationQuantity`, `completeCountSession`, `cancelCountSession`, `getCountSessionState` | **NEW** | per-SKU count session orchestration |
| `src/actions/locations.ts` | `listLocations`, `createLocation`, `createLocationRange`, `updateLocation`, `deactivateLocation`, `retryShipstationLocationSync` | **NEW** | locator system + ShipStation mirror |
| `src/actions/megaplan-spot-check.ts` | `triggerSpotCheck`, `listSpotCheckRuns`, `getSpotCheckArtifact` | **NEW** | verification UI |
| `src/actions/scanning.ts` | `submitCount` | existing — UNUSED by this plan | scanner path remains dormant |

## E.5. Webhook routes (no change)

The Phase 2 SHIP_NOTIFY route handler at `src/app/api/webhooks/shipstation/v2/route.ts` is **untouched** by this plan. Per Rule #66 it remains a thin verify+enqueue handler.

---

# Appendix F — Glossary

| Term | Plain meaning |
|---|---|
| **Mega-plan** | The umbrella plan named "ShipStation v2 as Inventory Source of Truth + Bandcamp ↔ ShipStation bridge" that we shipped Phases 0–6 of last week. This is its closeout pass + the late-Saturday additions. |
| **Closeout** | Final cleanup work that takes a phase from "code merged" to "verified live, documented, locked." |
| **Phase 7** | A future cleanup pass to delete dormant client-store webhook code paths. Deferred 90 days because we need real production data first. |
| **Tier 1 hardening** | A 14-item production-readiness gate (kill switches, monitoring, rollouts, etc.). 12 items are done; #9 (Better Stack) and #10 (statuspage.io) are waived 30 days. |
| **`fanout_rollout_percent`** | A 0–100 dial per workspace. 0% = changes don't push externally. 100% = full sync. We ramp gradually so a bug in fanout doesn't blast bad data across all SKUs at once. |
| **External sync ledger** (`external_sync_events`) | An append-only log that records every external API mutation (ShipStation push, Bandcamp push, etc.) with a unique key. Stops us from doing the same write twice if a task retries. |
| **Fanout** | The process of taking one inventory change in our DB and pushing it out to all the systems that need to know (ShipStation, Bandcamp, client stores, Clandestine Shopify). |
| **Single write path** (`recordInventoryChange()`) | The ONE function in our codebase that's allowed to change inventory numbers. Everything else routes through it. Enforced by a CI lint guard. |
| **Bundle** | A SKU that's actually a group of other SKUs (e.g., "LP + T-shirt combo"). We don't push bundles to ShipStation/Bandcamp directly because they're computed from their component SKUs. |
| **Distro item** | A product where `org_id IS NULL` — meaning we distribute it but no specific label owns it. Excluded from Bandcamp pushes. |
| **Spot-check** | An automated cross-system inventory comparison (DB vs Redis vs ShipStation vs Bandcamp) that runs hourly during the ramp weekend, then daily. |
| **Locator system** | The Tuesday morning shelf-labeling system: staff create location names (e.g., "A-3-2"), label physical shelves, then count each shelf into the app per-SKU. |
| **Location** | A physical place where stock lives — a shelf, bin, floor zone, or staging area. Tracked in `warehouse_locations` + per-SKU rows in `warehouse_variant_locations`. |
| **Count session** | Temporary state on a SKU (`count_status = 'count_in_progress'`) used while staff are entering per-shelf counts. While active, external pushes are suppressed; "Complete count" recomputes the total and fires one fanout. Prevents oversells from partial counts. |
| **ShipStation location mirror** | One-way sync: locations created in our app are also created in ShipStation, and we store the ShipStation ID locally. Inventory is then pushed per-location to ShipStation. ShipStation is downstream — we never read locations *from* ShipStation. |
| **`push_mode`** | A per-Bandcamp-mapping field (`normal` / `blocked_baseline` / `blocked_multi_origin` / `manual_override`) that gates whether we're allowed to push inventory to that Bandcamp SKU. Phase 1 outcome. |
| **Patch D2** | The probe-and-decision around ShipStation v2 boundary semantics: `decrement 1→0` works, `modify new_available: 0` is rejected (must use `adjust quantity: 0`), missing rows in v2 inventory listing == `available: 0`. |
| **Hot / Warm / Cold reconcile** | Three scheduled tasks that compare inventory across systems at different cadences (5min / 30min / 6hr). Hot auto-fixes minor drift, warm flags it, cold does a full audit. |
| **`sku_sync_status` view** | A live database view that joins inventory, mappings, and ledger so the admin UI can show one canonical "is this SKU synced?" answer per SKU. |
| **Ramp** | The Sunday/Monday process of moving `fanout_rollout_percent` from 0 → 10 → 50 → 100 with operator approval at each step. |

---

# Appendix G — Revision history

| Date | Author | Change |
|---|---|---|
| 2026-04-18 | agent (initial draft) | First version of the canonical doc. Restructures the Cursor-internal closeout plan into the standardized 14-section format with full plan body + 7 appendices. Inlines critical existing source for offline review. |
| 2026-04-19 | agent (review pass integration) | Hardening pass driven by external review. §15.3 GATE inserted as required probe before per-location rewrite. A-6 elevated to PROBE REQUIRED. R-19, R-20, R-21, R-22 added. §17.1 hardenings table added. C.5 unseeded-zero skip path added. C.7 createLocation 409 resolution + range throttle added. §27.3 operator guidance for low-shipping windows added. §15.6 fallback priority restructured to make per-location rewrite (3f) conditional on probe outcome (3e). OQ-1 + OQ-2 marked addressed. See §17.1 for the complete hardenings-to-code mapping. No code-base changes — plan-only update. |
| 2026-04-19 | agent (review pass v5 integration) | Third hardening pass (two reviewers). **CRITICAL: Vercel Server Action timeout fix on `createLocationRange`** — inline path capped at 30 entries (~12s budget), ranges >30 route to new `bulk-create-locations` Trigger task (Appendix C.17) using `shipstationQueue`, no execution ceiling. Throttle bumped 250ms→300ms for safety against shared v2 200 req/min bucket. **DDL gap fix:** §15.2 migration body now includes `has_per_location_data` (was only in Appendix C.2); v3-era comment block updated to v4 audit-only semantics. §19.6 added `has_per_location_data` operator-gated SQL reset escape valve. `shipstation-stale-location-cleanup` deferred item moved to 2026-04-23 (Thursday) with concrete script spec to reduce ShipStation pick-list UI pollution. §17 R-21 expanded to cover Vercel timeout + rate bucket failure modes. §17.1.c v5 hardenings table added. Known-limitation acknowledgements (no plan change): C.8 microsecond Redis-PG read r |
| 2026-04-13 | agent (v6 codebase verification pass) | Pre-build triple-check against live `src/` and `supabase/migrations/`. Fixed 5 compile-blocking renames (`createServerActionClient` → `await createServerSupabaseClient()` x13, `{ user, workspaceId }` → `{ userId, workspaceId }` x4, `user.id` → `userId` x5, NFR-6 factory name). Filled 1 functional gap (`megaplan_sample_skus_per_client` RPC SQL added to C.3 + migration renumber recommendation). Replaced B.9.6 fabricated `getStaffContext()` excerpt with verbatim `adjustInventory` source from `src/actions/inventory.ts`. Confirmed 4 already-shipped findings (`shipstation_v2` in ExternalSyncSystem union, `workspaces.shipstation_sync_paused`, `fanout-guard PAUSE_COLUMN["shipstation"]`, `shipstationQueue`). Flagged 4 pre-existing concerns as deferred follow-ups (migration ordering bug, missing `src/lib/shared/utils.ts`, missing `ROLE_MATRIX`, scanning.ts auth gap). Added §17.1.d v6 hardenings table with full plan-vs-codebase mapping. Recommended build-day dry-run gate: paste C.6 + C.7 + C.8 to feature branch, run `pnpm typecheck`, proceed only if clean. |ace (reviewer 1 §2 — true fix deferred), spot-check read skew (already mitigated by persistence rule). Plan-only update. |
| 2026-04-19 | agent (review pass v4 integration) | Second hardening pass driven by external review. **KEY CORRECTION: count-session formula reverted from `delta = sum - baseline` (v3, wrong default for Scenario A) to `delta = sum - current_available` (v4, safer default — favors under-decrement over over-decrement and over-sells).** Baseline column retained for audit metadata only — every cycle_count activity row records both values so operators can detect "sales during session" cases post-hoc. Other changes: (a) sticky `has_per_location_data` flag on `warehouse_inventory_levels` prevents SKU oscillation between per-location and SKU-total fanout (R-23 — silent ShipStation overwrite avoided); (b) `updateLocation` reordered ShipStation-first (local row not updated if ShipStation rename fails); (c) spot-check excludes count_in_progress SKUs, samples 15 SKUs (vs 5) prioritized by recent activity during ramp, and requires drift_major to repeat 2 consecutive runs before queue insertion; (d) §17 added R-23 (per-location oscillation, Medium/High) + R-24 (event-deterministic rollout, Medium/Medium); (e) §16 added A-22, A-23, A-24; (f) §22 added two new deferred items (`fanout-guard-sku-deterministic` 2026-05-13, `per-bin-sale-routing` 2026-07-13); (g) §17.1 split into v3 + v4 subsections. No code-base changes — plan-only update. |

(Future revisions will be appended here.)

---

# Appendix H — v1 of plan (reference)

This document is the v1 of `docs/plans/shipstation-source-of-truth-plan.md`. The mega-plan it closes out is held in the Cursor-internal workspace plan store at `~/.cursor/plans/megaplan_closeout_—_compressed_weekend,_manual-entry_counting_0056b39e.plan.md` (~5,900 lines including Phases 0–6 closeouts in Part 14.9). The Cursor-internal plan is the *living* execution log; this canonical doc is the *review-ready snapshot* of what remains plus the Saturday/Sunday additions for live counting + locator + ShipStation mirror.

If a reviewer needs the full Phase 0–6 narrative (D2 probe details, alias rectify Lua, sku_sync_status DDL, etc.), pull the Cursor-internal plan from the path above. The summary tables in §6 of this doc cite specific Part 14.9 subsections by line range so cross-referencing is mechanical.

**End of canonical plan v1.**
