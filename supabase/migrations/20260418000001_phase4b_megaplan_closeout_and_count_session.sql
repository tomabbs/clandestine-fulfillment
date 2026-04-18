-- Phase 4b — combined migration shipping in Saturday Workstream 1.
-- Brings together the Phase 6 closeout artifact storage AND the count-session
-- + ShipStation v2 location mirror columns that the WS3 features will use.
-- Bundled because the megaplan_sample_skus_per_client RPC's `coalesce(count_status, 'idle')`
-- filter requires the count_status column to exist at function compile time
-- (PostgreSQL parses SQL function bodies eagerly at CREATE).
--
-- Idempotent throughout (`if not exists` everywhere) so this can be re-applied
-- against an already-partially-migrated database without errors.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) megaplan_spot_check_runs — Phase 6 closeout artifact storage
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists megaplan_spot_check_runs (
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
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index if not exists megaplan_spot_check_runs_started_idx
  on megaplan_spot_check_runs (started_at desc);

create index if not exists megaplan_spot_check_runs_workspace_idx
  on megaplan_spot_check_runs (workspace_id, started_at desc);

alter table megaplan_spot_check_runs enable row level security;

drop policy if exists "staff_select_megaplan_spot_check_runs"
  on megaplan_spot_check_runs;
create policy "staff_select_megaplan_spot_check_runs"
  on megaplan_spot_check_runs for select
  to authenticated
  using (is_staff_user());

drop policy if exists "service_role_all_megaplan_spot_check_runs"
  on megaplan_spot_check_runs;
create policy "service_role_all_megaplan_spot_check_runs"
  on megaplan_spot_check_runs for all
  to service_role
  using (true)
  with check (true);

comment on table megaplan_spot_check_runs is
  'Hourly cross-system inventory verification artifacts. Each row = one workspace pass. Populated by the megaplan-spot-check Trigger task.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Per-SKU count-session columns on warehouse_inventory_levels
--
-- These ship in WS1 even though the UI/Server Actions land in WS3 because
-- the megaplan_sample_skus_per_client RPC (created later in this migration)
-- references count_status. Other count-session columns ride along to keep WS3
-- migration-free.
-- ─────────────────────────────────────────────────────────────────────────────

alter table warehouse_inventory_levels
  add column if not exists count_status text not null default 'idle',
  add column if not exists count_started_at timestamptz,
  add column if not exists count_started_by uuid references users(id),
  add column if not exists count_baseline_available integer,
  add column if not exists has_per_location_data boolean not null default false;

-- Add the CHECK constraint separately so it's safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'warehouse_inventory_levels_count_status_check'
  ) then
    alter table warehouse_inventory_levels
      add constraint warehouse_inventory_levels_count_status_check
      check (count_status in ('idle', 'count_in_progress'));
  end if;
end$$;

create index if not exists warehouse_inventory_levels_count_in_progress_idx
  on warehouse_inventory_levels (workspace_id)
  where count_status = 'count_in_progress';

comment on column warehouse_inventory_levels.count_status is
  'When count_in_progress, fanout is suppressed for per-location quantity writes; only completeCountSession() fires fanout. WS3 wires the UI/actions; WS1 ships the column so the spot-check RPC can filter on it. See plan §15.4 + CLAUDE.md Rule #74.';
comment on column warehouse_inventory_levels.count_baseline_available is
  'AUDIT-ONLY snapshot of available at startCountSession (review pass v3/v4). completeCountSession uses CURRENT available for delta math, NOT baseline. Both values are recorded on the cycle_count activity row so operators can detect "sale during session" cases via (sales_during_session = baseline - current_at_complete). See plan C.8 commentary.';
comment on column warehouse_inventory_levels.has_per_location_data is
  'Sticky flag (R-23). Set to true on first non-zero per-location write; never reset by automation. Once true, ShipStation v2 fanout MUST always write per-location, never fall back to single SKU-total writes — otherwise a transient empty-per-location state would overwrite ShipStation per-location records with one workspace-default-location write. Manual reset via documented operator-gated SQL (plan §19.6).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) ShipStation v2 location mirror columns on warehouse_locations
-- ─────────────────────────────────────────────────────────────────────────────

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

comment on column warehouse_locations.shipstation_inventory_location_id is
  'ShipStation v2 inventory_location_id mirrored from createLocation() Server Action. Our app is source of truth (Rule #75). Stored here so per-location inventory writes in shipstation-v2-sync-on-sku target the right ShipStation row.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Extend warehouse_inventory_activity.source CHECK to include count sources
--
-- Existing values verified via v6 codebase pass:
--   shopify, bandcamp, squarespace, woocommerce, shipstation, manual,
--   inbound, preorder, backfill, reconcile (added in 20260413000030).
-- Adding: cycle_count (count session deltas), manual_inventory_count
--         (legacy/standalone manual count entries).
-- ─────────────────────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) megaplan_sample_skus_per_client RPC (consumed by megaplan-spot-check)
--
-- Per-workspace sampler. Ranks SKUs by recent activity in the last
-- p_prioritize_recent_activity_hours window (so high-traffic SKUs are sampled
-- more often during ramp), excludes SKUs currently in count_in_progress when
-- p_exclude_count_in_progress is true (R-1: their inventory is mid-update so
-- transient drift would skew classification), then returns top p_per_client
-- per workspace.
--
-- security definer + grant to service_role so the Trigger task can call it
-- without RLS interference.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function megaplan_sample_skus_per_client(
  p_workspace_id uuid,
  p_per_client int default 5,
  p_exclude_count_in_progress boolean default true,
  p_prioritize_recent_activity_hours int default 4
)
returns table (
  sku text,
  variant_id uuid,
  workspace_id uuid,
  org_id uuid,
  last_activity_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select
      l.sku,
      l.variant_id,
      l.workspace_id,
      l.org_id,
      coalesce(max(a.created_at), 'epoch'::timestamptz) as last_activity_at,
      row_number() over (
        partition by l.workspace_id, l.org_id
        order by coalesce(max(a.created_at), 'epoch'::timestamptz) desc, random()
      ) as rn
    from warehouse_inventory_levels l
    left join warehouse_inventory_activity a
      on a.sku = l.sku
      and a.workspace_id = l.workspace_id
      and a.created_at > (now() - make_interval(hours => p_prioritize_recent_activity_hours))
    where l.workspace_id = p_workspace_id
      and l.org_id is not null
      and (
        not p_exclude_count_in_progress
        or coalesce(l.count_status, 'idle') = 'idle'
      )
    group by l.sku, l.variant_id, l.workspace_id, l.org_id
  )
  select sku, variant_id, workspace_id, org_id, last_activity_at
  from ranked
  where rn <= p_per_client;
$$;

grant execute on function megaplan_sample_skus_per_client(uuid, int, boolean, int) to service_role;

comment on function megaplan_sample_skus_per_client(uuid, int, boolean, int) is
  'Per-workspace SKU sampler for the megaplan-spot-check Trigger task. Prioritizes recently-active SKUs and excludes count_in_progress SKUs (R-1). Plan §17.1.d v6 hardening.';
