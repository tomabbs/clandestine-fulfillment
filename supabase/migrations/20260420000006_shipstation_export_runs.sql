-- ShipStation product-import export — run history.
--
-- Each row is one export attempt (full or incremental). The Trigger task
-- `shipstation-export` reads the row, builds the CSV + XLSX, uploads to
-- the `shipstation-exports` Storage bucket, and updates the row with the
-- storage paths + coverage metrics.
--
-- Incremental mode chooses `since_ts` from the previous COMPLETED row's
-- `data_max_ts` so chained "what's new since last export" runs stay
-- contiguous even if a run fails halfway.

create table if not exists shipstation_export_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  triggered_by_user_id uuid references users(id) on delete set null,

  -- 'full' = every variant; 'incremental' = variants where created_at > since_ts
  mode text not null check (mode in ('full', 'incremental')),

  -- Run lifecycle
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  task_run_id text,
  error text,

  -- Date-range bookkeeping
  -- since_ts: lower bound (exclusive) of variant.created_at for incremental runs.
  -- data_max_ts: max(created_at) of the variants actually included in this run —
  -- becomes the next incremental run's since_ts.
  since_ts timestamptz,
  data_max_ts timestamptz,

  -- Result counters
  total_variants_loaded int,
  rows_written int,
  duplicates_skipped int,
  coverage jsonb,
  duplicate_skus jsonb,

  -- Storage paths inside the `shipstation-exports` bucket
  csv_storage_path text,
  xlsx_storage_path text,
  summary_storage_path text,

  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_ssx_runs_workspace_started
  on shipstation_export_runs (workspace_id, started_at desc);

create index if not exists idx_ssx_runs_workspace_completed
  on shipstation_export_runs (workspace_id, completed_at desc nulls last)
  where status = 'completed';

alter table shipstation_export_runs enable row level security;

drop policy if exists "staff_select_shipstation_export_runs" on shipstation_export_runs;
create policy "staff_select_shipstation_export_runs"
  on shipstation_export_runs for select
  to authenticated
  using (is_staff_user());

drop policy if exists "service_role_all_shipstation_export_runs" on shipstation_export_runs;
create policy "service_role_all_shipstation_export_runs"
  on shipstation_export_runs for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- Storage bucket + policies for the generated CSV/XLSX/summary files.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('shipstation-exports', 'shipstation-exports', false)
on conflict (id) do nothing;

drop policy if exists "staff_select_shipstation_exports" on storage.objects;
create policy "staff_select_shipstation_exports"
  on storage.objects for select to authenticated
  using (bucket_id = 'shipstation-exports' and is_staff_user());

drop policy if exists "service_role_all_shipstation_exports" on storage.objects;
create policy "service_role_all_shipstation_exports"
  on storage.objects for all to service_role
  using (bucket_id = 'shipstation-exports')
  with check (bucket_id = 'shipstation-exports');
