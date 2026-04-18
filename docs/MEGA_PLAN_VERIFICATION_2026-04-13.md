# Mega-plan verification artifact — 2026-04-13

> One-time, point-in-time attestation that the ShipStation Source-of-Truth
> mega-plan reached the closeout gate. This document is signed by the
> operator at end of weekend ramp (Mon ~17:00 ET) and committed to
> `docs/archive/` along with the mega-plan when archival ships.
>
> Sections A–D are pre-filled by the build agent during Saturday Workstream 1.
> Section E (operator signoff) is filled in Monday afternoon after the final
> ramp checkpoint.

---

## Section A — Automated gate results

These commands were run from the repo root on the date below. Capture the
exit code and (where relevant) summary line of output. If any line shows
`FAIL`, the closeout cannot be signed without an explicit waiver tracked in
`DEFERRED_FOLLOWUPS.md`.

| Gate | Status | Run at | Notes |
|---|---|---|---|
| `pnpm typecheck` | _PASS / FAIL_ | _ISO timestamp_ | _command output summary_ |
| `pnpm test` | _N tests passed / N failed_ | _ISO timestamp_ | _failures, if any_ |
| `pnpm check` (Biome) | _PASS / FAIL_ | _ISO timestamp_ | _new findings, if any_ |
| `pnpm build` | _PASS / FAIL_ | _ISO timestamp_ | _bundle size delta_ |
| `pnpm release:gate` | _PASS / FAIL_ | _ISO timestamp_ | _section D manual checks status_ |
| `supabase migration list --linked` | _migrations 40+50 applied YES / NO_ | _ISO timestamp_ | _full latest_migration value_ |

---

## Section B — Phase 4 / 5 / 6 closeout summaries

Pre-filled from mega-plan Part 14.9. Each entry should match the original
closeout report verbatim — no summary editing.

### Phase 4 — Bidirectional bridge (Bandcamp ↔ ShipStation v2)

- **Status:** SHIPPED on _date_ at run _id_.
- **Implementation notes:** `shipstation-v2-decrement` (forward leg, sale →
  ShipStation) and `bandcamp-push-on-sku` (reverse leg, SHIP_NOTIFY →
  Bandcamp) both ledger-gated via `external_sync_events` and respect the
  workspace `fanout_rollout_percent` bucket via `fanout-guard.ts`.
- **Deviations:** _list deviations from plan or "none"_.
- **Files changed:** _list file paths or link to PR_.
- **Follow-ups absorbed:** _bullets_.
- **Next phase assessment:** Phase 5 ready (reconcile sensor needed to detect
  drift created by either leg).

### Phase 5 — Tiered reconcile sensor + sku_sync_status view

- **Status:** SHIPPED on _date_ at run _id_.
- **Implementation notes:** Three Trigger schedules (`-hot` 5m, `-warm` 30m,
  `-cold` 6h) call the same inner runner (`shipstationBandcampReconcileTask`).
  All pinned to `shipstationQueue` (concurrency 1). `sku_sync_status` view
  shipped (live, not materialized). Admin page at
  `/admin/settings/shipstation-inventory` provides per-tier rerun + per-SKU
  spot-lookup.
- **Drift policy:** `|drift| ≤ 1` silent fix, 2-5 low-severity review item,
  &gt;5 high-severity review item. ALWAYS adjusts our DB to match v2 via
  `recordInventoryChange(source: 'reconcile')`.
- **Deviations:** _list_.
- **Files changed:** _list_.
- **Follow-ups absorbed:** _bullets_.
- **Next phase assessment:** Phase 6 ready.

### Phase 6 — Validation drill + automated spot-check

- **Status:** SHIPPED on 2026-04-18 (Saturday Workstream 1).
- **Implementation notes:** New `megaplan-spot-check` Trigger task samples 5
  SKUs per workspace (15 during ramp) hourly, classifies drift across DB /
  Redis / ShipStation v2 / Bandcamp, persists to `megaplan_spot_check_runs`,
  and creates a `warehouse_review_queue` item only when drift_major persists
  across two consecutive runs (review pass v4 §5.3 — eliminates transient
  lag noise). Admin page at `/admin/settings/megaplan-verification`. Daily
  `deferred-followups-reminder` task parses `docs/DEFERRED_FOLLOWUPS.md` and
  upserts queue items for due entries.
- **Deviations from plan:** _list, then "n/a" if none_.
- **Files changed:**
  - `supabase/migrations/20260418000001_phase4b_megaplan_closeout_and_count_session.sql`
  - `src/trigger/tasks/megaplan-spot-check.ts`
  - `src/trigger/tasks/deferred-followups-reminder.ts`
  - `src/actions/megaplan-spot-check.ts`
  - `src/app/admin/settings/megaplan-verification/page.tsx`
  - `src/components/admin/admin-sidebar.tsx`
  - `src/trigger/tasks/index.ts`
  - `trigger.config.ts`
  - `docs/DEFERRED_FOLLOWUPS.md`
  - `docs/MEGA_PLAN_VERIFICATION_2026-04-13.md`
- **Follow-ups absorbed:** v6 codebase verification findings registered in
  `DEFERRED_FOLLOWUPS.md` (4 entries: migration ordering, shared utils path,
  ROLE_MATRIX rename, scanning auth audit).
- **Next phase assessment:** Phase 7 (dormant client-store cleanup) deferred
  pending 90-day dormancy review, tracked in `DEFERRED_FOLLOWUPS.md`.

---

## Section C — Deferred items (auto-filled from `DEFERRED_FOLLOWUPS.md`)

Snapshot of the registry at signoff time. Future changes to the registry
should NOT be back-applied to this artifact — this is a point-in-time
attestation.

| Slug | Title | Due date | Severity | Notes |
|---|---|---|---|---|
| phase-7-dormant-cleanup | Phase 7: dormant client-store code cleanup | 2026-07-13 | medium | 90-day dormancy review |
| tier1-9-better-stack | Tier 1 #9: Better Stack synthetic monitoring | 2026-05-13 | high | 30-day waiver |
| tier1-10-statuspage | Tier 1 #10: statuspage.io public status page | 2026-05-13 | high | 30-day waiver |
| external-sync-events-retention | external_sync_events retention cron verification | 2026-04-25 | low | one-week verification |
| shipstation-stale-location-cleanup | Stale ShipStation v2 location cleanup script | 2026-05-21 | low | atrophy strategy follow-up |
| migration-ordering-from-scratch | external_sync_events migration ordering bug | 2026-05-31 | medium | from-scratch deploy fix |
| shared-utils-path | Create src/lib/shared/utils.ts canonical home | 2026-05-15 | low | Rule #57 alignment |
| role-matrix-rename | Add ROLE_MATRIX export to constants | 2026-05-15 | low | Rule #40 alignment |
| scanning-auth-audit | Audit src/actions/scanning.ts requireStaff() coverage | 2026-05-15 | medium | defense-in-depth |

---

## Section D — Tier 1 hardening status

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Per-integration kill switches | DONE | `shipstation_sync_paused` (migration 50, idempotent — already existed), `bandcamp_sync_paused`, `clandestine_shopify_sync_paused`, `client_store_sync_paused` (all in migration 10) |
| 2 | Service-role audit | DONE | `service_role` writes only via Trigger tasks; client portal uses anon key strictly |
| 3 | Tenant-isolation CI | DONE | RLS coverage tests in `tests/unit/rls/` |
| 4 | Distributed tracing | DONE | Sentry + Trigger.dev run IDs threaded through `correlation_id` |
| 5 | SLOs documented | DONE | See `TRUTH_LAYER.md` §SLO |
| 6 | Dependabot enabled | DONE | `.github/dependabot.yml` |
| 7 | Secret rotation runbook | DONE | `docs/runbooks/secrets.md` |
| 8 | Backup verification probe | DONE | `weekly-backup-verify` task |
| 9 | Better Stack synthetic monitoring | **WAIVED 30 days** | Due 2026-05-13 — `DEFERRED_FOLLOWUPS.md` slug `tier1-9-better-stack`. Operator accepts manual monitoring during onboarding week. |
| 10 | statuspage.io public status page | **WAIVED 30 days** | Due 2026-05-13 — slug `tier1-10-statuspage`. |
| 11 | Daily reconciliation summary | DONE | `daily-recon-summary` task |
| 12 | Runbooks | DONE | `docs/runbooks/` |
| 13 | Percentage rollouts | DONE | `fanout_rollout_percent` per workspace (migration 10) |
| 14 | `external_sync_events` retention cron | DONE | `external-sync-events-retention` task (Patch D3); verification due 2026-04-25 |

---

## Section E — Operator signoff (Mon ~17:00)

### Ramp evidence

| Stage | Time (ET) | Run ID | Drift major count | Notes |
|---|---|---|---|---|
| 0% → 10% | _Sun ~12:00_ | _run id_ | _count_ | _notes_ |
| 10% → 50% | _Sun ~16:00_ | _run id_ | _count_ | _notes_ |
| 50% → 100% | _Mon ~09:00_ | _run id_ | _count_ | _notes_ |

### Spot-check evidence (final 24 hours)

- _List run IDs from `megaplan_spot_check_runs` ordered by started_at DESC._
- _Confirm: zero `drift_major` after the persistence rule, OR explicit
  acknowledgement that residual drift_major is tracked in
  `warehouse_review_queue` with an assigned owner._

### UX dry run results

| Run | Date / Time | Part A (count single SKU) | Part B (concurrent counts) | Per-shelf time | Per-SKU avg |
|---|---|---|---|---|---|
| #1 | _Sun 10:00_ | _PASS / FAIL_ | _PASS / FAIL_ | _min_ | _s_ |
| #2 | _Mon 14:00_ | _PASS / FAIL_ | _PASS / FAIL_ | _min_ | _s_ |

### Tier 1 #9 + #10 waiver text

> Better Stack synthetic monitoring and statuspage.io public status page are
> deferred to 2026-05-13. Acceptance: agreed risk to onboard staff Tuesday
> April 21 with manual operator monitoring during the first week. Ramp to
> 100% authorized despite open waivers. The waivers are tracked in
> `docs/DEFERRED_FOLLOWUPS.md` and surfaced via the daily
> `deferred-followups-reminder` cron.

### Operator signature

| Field | Value |
|---|---|
| Operator name | _________________ |
| Operator role | _________________ |
| Date signed | _________________ |
| Mega-plan archive PR | _________________ |

---

_End of MEGA_PLAN_VERIFICATION_2026-04-13.md._
