-- Phase 2 — SKU matching hardening
--
-- Adds:
--   - lean current-state provenance columns on client_store_sku_mappings
--   - append-only sku_mapping_events audit table
--   - active-row unique indexes (after Phase 0 duplicate cleanup)
--   - persist_sku_match RPC
--   - duplicate-inspection RPCs for the Conflicts tab

alter table client_store_sku_mappings
  add column if not exists match_method text,
  add column if not exists match_confidence text,
  add column if not exists matched_by uuid references users(id),
  add column if not exists matched_at timestamptz,
  add column if not exists deactivated_by uuid references users(id),
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivation_reason text,
  add column if not exists candidate_fingerprint text;

create table if not exists sku_mapping_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  mapping_id uuid references client_store_sku_mappings(id) on delete set null,
  connection_id uuid not null references client_store_connections(id) on delete cascade,
  variant_id uuid not null references warehouse_product_variants(id) on delete cascade,
  canonical_sku text,
  remote_sku text,
  remote_product_id text,
  remote_variant_id text,
  remote_inventory_item_id text,
  event_type text not null,
  match_method text,
  match_confidence text,
  match_reasons jsonb,
  candidate_snapshot jsonb,
  candidate_fingerprint text,
  actor_id uuid references users(id),
  actor_role text,
  notes text,
  deactivation_reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sku_mapping_events_workspace_created
  on sku_mapping_events(workspace_id, created_at desc);

create index if not exists idx_sku_mapping_events_mapping
  on sku_mapping_events(mapping_id, created_at desc);

alter table sku_mapping_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sku_mapping_events'
      and policyname = 'staff_all'
  ) then
    create policy staff_all on sku_mapping_events
      for all to authenticated
      using (is_staff_user())
      with check (is_staff_user());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sku_mapping_events'
      and policyname = 'client_select'
  ) then
    create policy client_select on sku_mapping_events
      for select to authenticated
      using (
        exists (
          select 1
          from client_store_connections csc
          where csc.id = sku_mapping_events.connection_id
            and csc.org_id = get_user_org_id()
        )
      );
  end if;
end $$;

drop index if exists idx_sku_mappings_connection_inventory_item;

create unique index if not exists idx_sku_mappings_active_connection_variant
  on client_store_sku_mappings(connection_id, variant_id)
  where is_active = true;

create unique index if not exists idx_sku_mappings_active_connection_remote_inventory_item
  on client_store_sku_mappings(connection_id, remote_inventory_item_id)
  where is_active = true and remote_inventory_item_id is not null;

create unique index if not exists idx_sku_mappings_active_connection_remote_variant
  on client_store_sku_mappings(connection_id, remote_variant_id)
  where is_active = true and remote_variant_id is not null;

create or replace function persist_sku_match(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_variant_id uuid,
  p_remote_product_id text,
  p_remote_variant_id text,
  p_remote_inventory_item_id text,
  p_remote_sku text,
  p_actor_id uuid,
  p_match_method text,
  p_match_confidence text,
  p_match_reasons jsonb default '[]'::jsonb,
  p_candidate_snapshot jsonb default '{}'::jsonb,
  p_candidate_fingerprint text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mapping_id uuid;
  v_actor_role text;
  v_canonical_sku text;
begin
  select sku into v_canonical_sku
  from warehouse_product_variants
  where id = p_variant_id
    and workspace_id = p_workspace_id;

  if v_canonical_sku is null then
    raise exception 'persist_sku_match: variant % not found in workspace %', p_variant_id, p_workspace_id;
  end if;

  select role into v_actor_role
  from users
  where id = p_actor_id;

  update client_store_sku_mappings
  set
    is_active = false,
    deactivated_by = p_actor_id,
    deactivated_at = now(),
    deactivation_reason = 'superseded_by_persist_sku_match',
    updated_at = now()
  where connection_id = p_connection_id
    and is_active = true
    and id <> coalesce(v_mapping_id, gen_random_uuid())
    and (
      variant_id = p_variant_id
      or (p_remote_inventory_item_id is not null and remote_inventory_item_id = p_remote_inventory_item_id)
      or (p_remote_variant_id is not null and remote_variant_id = p_remote_variant_id)
    );

  select id
  into v_mapping_id
  from client_store_sku_mappings
  where connection_id = p_connection_id
    and (
      variant_id = p_variant_id
      or (p_remote_inventory_item_id is not null and remote_inventory_item_id = p_remote_inventory_item_id)
      or (p_remote_variant_id is not null and remote_variant_id = p_remote_variant_id)
    )
  order by is_active desc, updated_at desc, created_at desc
  limit 1;

  if v_mapping_id is null then
    insert into client_store_sku_mappings (
      workspace_id,
      connection_id,
      variant_id,
      remote_product_id,
      remote_variant_id,
      remote_inventory_item_id,
      remote_sku,
      is_active,
      match_method,
      match_confidence,
      matched_by,
      matched_at,
      candidate_fingerprint,
      updated_at
    )
    values (
      p_workspace_id,
      p_connection_id,
      p_variant_id,
      p_remote_product_id,
      p_remote_variant_id,
      p_remote_inventory_item_id,
      p_remote_sku,
      true,
      p_match_method,
      p_match_confidence,
      p_actor_id,
      now(),
      p_candidate_fingerprint,
      now()
    )
    returning id into v_mapping_id;
  else
    update client_store_sku_mappings
    set
      workspace_id = p_workspace_id,
      connection_id = p_connection_id,
      variant_id = p_variant_id,
      remote_product_id = p_remote_product_id,
      remote_variant_id = p_remote_variant_id,
      remote_inventory_item_id = p_remote_inventory_item_id,
      remote_sku = p_remote_sku,
      is_active = true,
      match_method = p_match_method,
      match_confidence = p_match_confidence,
      matched_by = p_actor_id,
      matched_at = now(),
      deactivated_by = null,
      deactivated_at = null,
      deactivation_reason = null,
      candidate_fingerprint = p_candidate_fingerprint,
      updated_at = now()
    where id = v_mapping_id;
  end if;

  insert into sku_mapping_events (
    workspace_id,
    mapping_id,
    connection_id,
    variant_id,
    canonical_sku,
    remote_sku,
    remote_product_id,
    remote_variant_id,
    remote_inventory_item_id,
    event_type,
    match_method,
    match_confidence,
    match_reasons,
    candidate_snapshot,
    candidate_fingerprint,
    actor_id,
    actor_role,
    notes
  )
  values (
    p_workspace_id,
    v_mapping_id,
    p_connection_id,
    p_variant_id,
    v_canonical_sku,
    p_remote_sku,
    p_remote_product_id,
    p_remote_variant_id,
    p_remote_inventory_item_id,
    'matched',
    p_match_method,
    p_match_confidence,
    coalesce(p_match_reasons, '[]'::jsonb),
    coalesce(p_candidate_snapshot, '{}'::jsonb),
    p_candidate_fingerprint,
    p_actor_id,
    v_actor_role,
    p_notes
  );

  return v_mapping_id;
end;
$$;

create or replace function find_canonical_to_remote_dupes(
  p_workspace_id uuid,
  p_connection_id uuid
)
returns table (
  canonical_sku text,
  remote_key text,
  mapping_ids uuid[],
  row_count bigint,
  reason text
)
language sql
security definer
set search_path = public
as $$
  select
    wpv.sku as canonical_sku,
    coalesce(csm.remote_inventory_item_id, csm.remote_variant_id, csm.remote_product_id, upper(trim(csm.remote_sku))) as remote_key,
    array_agg(csm.id order by csm.updated_at desc, csm.created_at desc) as mapping_ids,
    count(*) as row_count,
    'canonical_to_remote'::text as reason
  from client_store_sku_mappings csm
  inner join warehouse_product_variants wpv on wpv.id = csm.variant_id
  where csm.workspace_id = p_workspace_id
    and csm.connection_id = p_connection_id
    and csm.is_active = true
  group by
    wpv.sku,
    coalesce(csm.remote_inventory_item_id, csm.remote_variant_id, csm.remote_product_id, upper(trim(csm.remote_sku)))
  having count(*) > 1
$$;

create or replace function find_remote_to_canonical_dupes(
  p_workspace_id uuid,
  p_connection_id uuid
)
returns table (
  canonical_sku text,
  remote_key text,
  mapping_ids uuid[],
  row_count bigint,
  reason text
)
language sql
security definer
set search_path = public
as $$
  select
    min(wpv.sku) as canonical_sku,
    coalesce(csm.remote_inventory_item_id, csm.remote_variant_id, csm.remote_product_id, upper(trim(csm.remote_sku))) as remote_key,
    array_agg(csm.id order by csm.updated_at desc, csm.created_at desc) as mapping_ids,
    count(*) as row_count,
    'remote_to_canonical'::text as reason
  from client_store_sku_mappings csm
  inner join warehouse_product_variants wpv on wpv.id = csm.variant_id
  where csm.workspace_id = p_workspace_id
    and csm.connection_id = p_connection_id
    and csm.is_active = true
    and coalesce(csm.remote_inventory_item_id, csm.remote_variant_id, csm.remote_product_id, upper(trim(csm.remote_sku))) is not null
  group by coalesce(csm.remote_inventory_item_id, csm.remote_variant_id, csm.remote_product_id, upper(trim(csm.remote_sku)))
  having count(*) > 1
$$;

create or replace function find_canonical_sku_duplicates(
  p_workspace_id uuid,
  p_connection_id uuid
)
returns table (
  canonical_sku text,
  remote_key text,
  mapping_ids uuid[],
  row_count bigint,
  reason text
)
language sql
security definer
set search_path = public
as $$
  select
    wpv.sku as canonical_sku,
    null::text as remote_key,
    array_agg(csm.id order by csm.updated_at desc, csm.created_at desc) as mapping_ids,
    count(*) as row_count,
    'canonical_sku_duplicate'::text as reason
  from client_store_sku_mappings csm
  inner join warehouse_product_variants wpv on wpv.id = csm.variant_id
  where csm.workspace_id = p_workspace_id
    and csm.connection_id = p_connection_id
    and csm.is_active = true
  group by wpv.sku
  having count(*) > 1
$$;

grant execute on function persist_sku_match(uuid, uuid, uuid, text, text, text, text, uuid, text, text, jsonb, jsonb, text, text) to authenticated, service_role;
grant execute on function find_canonical_to_remote_dupes(uuid, uuid) to authenticated, service_role;
grant execute on function find_remote_to_canonical_dupes(uuid, uuid) to authenticated, service_role;
grant execute on function find_canonical_sku_duplicates(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
