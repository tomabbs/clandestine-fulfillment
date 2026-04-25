-- Phase 6 — SKU matching telemetry / monitoring substrate

create table if not exists sku_matching_perf_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  connection_id uuid references client_store_connections(id) on delete cascade,
  actor_id uuid references users(id),
  event_type text not null,
  duration_ms integer,
  row_count integer,
  matched_count integer,
  needs_review_count integer,
  remote_only_count integer,
  conflict_count integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_sku_matching_perf_workspace_created
  on sku_matching_perf_events(workspace_id, created_at desc);

create index if not exists idx_sku_matching_perf_event_type
  on sku_matching_perf_events(event_type, created_at desc);

alter table sku_matching_perf_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sku_matching_perf_events'
      and policyname = 'staff_all'
  ) then
    create policy staff_all on sku_matching_perf_events
      for all to authenticated
      using (is_staff_user())
      with check (is_staff_user());
  end if;
end $$;

notify pgrst, 'reload schema';
