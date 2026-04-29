-- Phase 5b — Platform fulfillment writeback parity
--
-- Introduces explicit, line-grain writeback ledger so multi-shipment direct
-- orders can no longer be falsely reported as "succeeded" once the first
-- shipment writes back. Order-level status is derived from line statuses.
--
-- Idempotent: every CREATE statement is guarded; every drop falls back to
-- IF EXISTS so partial-applied environments converge.

do $$ begin
  create type platform_fulfillment_writeback_status as enum (
    'pending',
    'in_progress',
    'succeeded',
    'partial_succeeded',
    'failed_retryable',
    'failed_terminal',
    'not_required',
    'blocked_missing_identity',
    'blocked_bandcamp_generic_path'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type platform_fulfillment_writeback_line_status as enum (
    'pending',
    'in_progress',
    'succeeded',
    'failed_retryable',
    'failed_terminal',
    'not_required'
  );
exception when duplicate_object then null; end $$;

create table if not exists platform_fulfillment_writebacks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  warehouse_order_id uuid not null references warehouse_orders(id) on delete cascade,
  shipment_id uuid null references warehouse_shipments(id) on delete set null,
  platform text not null,
  connection_id uuid null references client_store_connections(id) on delete set null,
  external_order_id text null,
  status platform_fulfillment_writeback_status not null default 'pending',
  attempt_count int not null default 0,
  last_attempt_at timestamptz null,
  succeeded_at timestamptz null,
  failed_at timestamptz null,
  error_code text null,
  error_message text null,
  request_summary jsonb not null default '{}'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_platform_fulfillment_writebacks_warehouse_order
  on platform_fulfillment_writebacks (warehouse_order_id);

create index if not exists idx_platform_fulfillment_writebacks_workspace_status
  on platform_fulfillment_writebacks (workspace_id, status);

-- One active writeback row per (warehouse_order, shipment, platform). Replays
-- mutate the existing row rather than spawning duplicates that would diverge
-- the order-level derived status.
create unique index if not exists uq_platform_fulfillment_writeback_dedup
  on platform_fulfillment_writebacks (warehouse_order_id, coalesce(shipment_id, '00000000-0000-0000-0000-000000000000'::uuid), platform);

create table if not exists platform_fulfillment_writeback_lines (
  id uuid primary key default gen_random_uuid(),
  writeback_id uuid not null references platform_fulfillment_writebacks(id) on delete cascade,
  warehouse_order_item_id uuid not null references warehouse_order_items(id) on delete cascade,
  quantity_fulfilled int not null check (quantity_fulfilled > 0),
  external_line_id text null,
  status platform_fulfillment_writeback_line_status not null default 'pending',
  attempt_count int not null default 0,
  last_attempt_at timestamptz null,
  error_code text null,
  error_message text null,
  request_summary jsonb not null default '{}'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (writeback_id, warehouse_order_item_id)
);

create index if not exists idx_platform_fulfillment_writeback_lines_writeback
  on platform_fulfillment_writeback_lines (writeback_id);

alter table platform_fulfillment_writebacks enable row level security;
alter table platform_fulfillment_writeback_lines enable row level security;

drop policy if exists platform_fulfillment_writebacks_staff_all
  on platform_fulfillment_writebacks;
create policy platform_fulfillment_writebacks_staff_all
  on platform_fulfillment_writebacks
  for all
  to authenticated
  using (is_staff_user())
  with check (is_staff_user());

drop policy if exists platform_fulfillment_writeback_lines_staff_all
  on platform_fulfillment_writeback_lines;
create policy platform_fulfillment_writeback_lines_staff_all
  on platform_fulfillment_writeback_lines
  for all
  to authenticated
  using (is_staff_user())
  with check (is_staff_user());

comment on table platform_fulfillment_writebacks is
  'Phase 5b — order-level platform fulfillment writeback ledger; status is derived from platform_fulfillment_writeback_lines. Direct Orders renders writeback state from this table rather than inferring from warehouse_orders.fulfillment_status.';
comment on table platform_fulfillment_writeback_lines is
  'Phase 5b — per-line/per-quantity writeback state so multi-shipment direct orders cannot be falsely reported as succeeded after the first shipment writes back. UNIQUE(writeback_id, warehouse_order_item_id) blocks retry-storm duplicates.';
