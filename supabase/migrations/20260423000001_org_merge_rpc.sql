-- Migration: Org-merge RPC + collision pre-check (HRD-36)
--
-- Replaces the in-app TS-only merge function at src/actions/organizations.ts.
-- Six bugs fixed:
--   (1) Missing org_id-bearing tables — full audit performed 2026-04-22:
--         mailorder_orders                (NOT NULL FK — was hard-blocking source DELETE)
--         oauth_states                    (NOT NULL FK — was hard-blocking source DELETE)
--         shipstation_orders              (nullable — was silently orphaning rows)
--         sku_sync_conflicts              (nullable — was silently orphaning rows)
--         warehouse_billing_rule_overrides (NOT NULL FK — was hard-blocking source DELETE; not
--                                          surfaced in HRD-36 plan text but caught during execution)
--       Note: megaplan_spot_check_runs (called out in plan) does NOT actually have an org_id
--       column — the org_id reference at line 170 of the megaplan migration is a function-return
--       signature, not a table column. Excluded from the canonical list.
--   (2) Silent failures inside loop — every UPDATE/DELETE inside the RPC raises on error
--       (PL/pgSQL native semantics; no `.update().error` swallow path).
--   (3) Not transactional — entire merge runs inside a single PL/pgSQL function = single
--       implicit transaction. Mid-merge crash → automatic ROLLBACK. Rule #64 satisfied.
--   (4) previewMerge underreporting — preview_merge_organizations RPC walks the same
--       canonical list, returns an exact count per table.
--   (5) warehouse_inventory_levels trigger interaction — Rule #21 says trg_derive_inventory_org_id
--       BEFORE INSERT OR UPDATE re-derives org_id from variant→product on every write.
--       Order matters: warehouse_products MUST be reassigned BEFORE warehouse_inventory_levels
--       so the trigger derives the new (target) org_id. We honour this ordering deterministically
--       via the array order. We also emit a final touch UPDATE on warehouse_inventory_levels
--       that lets the BEFORE trigger recompute. We do NOT use session_replication_role='replica'
--       because that requires SUPERUSER (not granted to service_role on Supabase) AND would
--       silently disable other safety triggers in the same transaction.
--   (6) UNIQUE-constraint collisions — preview_merge_organizations enumerates every collision
--       BEFORE the merge runs; merge_organizations_txn re-checks and aborts with a structured
--       error if any new collisions appeared in the gap between preview and confirm.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────────────
-- preview_merge_organizations
--
-- Returns:
--   {
--     "source_name":   text,
--     "target_name":   text,
--     "affected_rows": { "<table_name>": <int>, ... }   // tables with > 0 source rows
--     "total_affected": <int>,                          // sum of above values
--     "collisions": [                                   // empty array if none
--       { "table": text, "constraint": text, "key": jsonb, "source_row_id": uuid|null,
--         "target_row_id": uuid|null }, ...
--     ]
--   }
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function preview_merge_organizations(
  p_source_org_id uuid,
  p_target_org_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source record;
  v_target record;
  v_affected jsonb := '{}'::jsonb;
  v_collisions jsonb := '[]'::jsonb;
  v_total int := 0;
  v_count int;
  v_row record;
  v_tables text[] := array[
    -- Order matters for merge_organizations_txn — keep warehouse_products before
    -- warehouse_inventory_levels so the inventory derivation trigger sees the
    -- already-reassigned product when it re-derives org_id (Rule #21 / Bug 5).
    'warehouse_products',
    'warehouse_shipments',
    'warehouse_orders',
    'warehouse_inbound_shipments',
    'warehouse_billing_snapshots',
    'warehouse_billing_adjustments',
    'warehouse_billing_rule_overrides',
    'warehouse_inventory_levels',
    'warehouse_shipstation_stores',
    'warehouse_review_queue',
    'bandcamp_connections',
    'client_store_connections',
    'mailorder_orders',
    'oauth_states',
    'shipstation_orders',
    'sku_sync_conflicts',
    'support_conversations',
    'support_email_mappings',
    'portal_admin_settings',
    'users',
    'organization_aliases'
  ];
  v_table text;
begin
  if p_source_org_id is null or p_target_org_id is null then
    raise exception 'merge_invalid_input: source and target org ids are required';
  end if;
  if p_source_org_id = p_target_org_id then
    raise exception 'merge_invalid_input: source and target must differ';
  end if;

  select id, name, workspace_id into v_source
  from organizations where id = p_source_org_id;
  if v_source.id is null then
    raise exception 'merge_source_not_found: %', p_source_org_id;
  end if;

  select id, name, workspace_id into v_target
  from organizations where id = p_target_org_id;
  if v_target.id is null then
    raise exception 'merge_target_not_found: %', p_target_org_id;
  end if;

  if v_source.workspace_id is distinct from v_target.workspace_id then
    raise exception 'merge_workspace_mismatch: source workspace=% target workspace=%',
      v_source.workspace_id, v_target.workspace_id;
  end if;

  -- Per-table row counts.
  foreach v_table in array v_tables loop
    execute format('select count(*)::int from %I where org_id = $1', v_table)
      into v_count
      using p_source_org_id;
    if v_count > 0 then
      v_affected := v_affected || jsonb_build_object(v_table, v_count);
      v_total := v_total + v_count;
    end if;
  end loop;

  -- Collision detection. Each block targets one UNIQUE constraint that
  -- includes org_id (or whose effective uniqueness scope would collapse on merge).

  -- portal_admin_settings UNIQUE (workspace_id, org_id)
  for v_row in
    select s.id as source_row_id, t.id as target_row_id
    from portal_admin_settings s
    join portal_admin_settings t
      on t.workspace_id = s.workspace_id
     and t.org_id = p_target_org_id
    where s.org_id = p_source_org_id
  loop
    v_collisions := v_collisions || jsonb_build_array(jsonb_build_object(
      'table', 'portal_admin_settings',
      'constraint', 'portal_admin_settings_workspace_id_org_id_key',
      'key', jsonb_build_object('workspace_id', v_source.workspace_id),
      'source_row_id', v_row.source_row_id,
      'target_row_id', v_row.target_row_id
    ));
  end loop;

  -- warehouse_billing_snapshots UNIQUE (workspace_id, org_id, billing_period)
  for v_row in
    select s.id as source_row_id, t.id as target_row_id, s.billing_period::text as bp
    from warehouse_billing_snapshots s
    join warehouse_billing_snapshots t
      on t.workspace_id = s.workspace_id
     and t.org_id = p_target_org_id
     and t.billing_period = s.billing_period
    where s.org_id = p_source_org_id
  loop
    v_collisions := v_collisions || jsonb_build_array(jsonb_build_object(
      'table', 'warehouse_billing_snapshots',
      'constraint', 'warehouse_billing_snapshots_workspace_id_org_id_billing_period_key',
      'key', jsonb_build_object('billing_period', v_row.bp),
      'source_row_id', v_row.source_row_id,
      'target_row_id', v_row.target_row_id
    ));
  end loop;

  -- warehouse_billing_rule_overrides UNIQUE (workspace_id, org_id, rule_id)
  for v_row in
    select s.id as source_row_id, t.id as target_row_id, s.rule_id::text as rid
    from warehouse_billing_rule_overrides s
    join warehouse_billing_rule_overrides t
      on t.workspace_id = s.workspace_id
     and t.org_id = p_target_org_id
     and t.rule_id = s.rule_id
    where s.org_id = p_source_org_id
  loop
    v_collisions := v_collisions || jsonb_build_array(jsonb_build_object(
      'table', 'warehouse_billing_rule_overrides',
      'constraint', 'warehouse_billing_rule_overrides_workspace_id_org_id_rule_id_key',
      'key', jsonb_build_object('rule_id', v_row.rid),
      'source_row_id', v_row.source_row_id,
      'target_row_id', v_row.target_row_id
    ));
  end loop;

  -- mailorder_orders UNIQUE (workspace_id, source, external_order_id, org_id)
  for v_row in
    select s.id as source_row_id, t.id as target_row_id,
           s.source as src_kind, s.external_order_id as ext_id
    from mailorder_orders s
    join mailorder_orders t
      on t.workspace_id = s.workspace_id
     and t.source = s.source
     and t.external_order_id = s.external_order_id
     and t.org_id = p_target_org_id
    where s.org_id = p_source_org_id
  loop
    v_collisions := v_collisions || jsonb_build_array(jsonb_build_object(
      'table', 'mailorder_orders',
      'constraint', 'mailorder_orders_workspace_id_source_external_order_id_org_id_key',
      'key', jsonb_build_object('source', v_row.src_kind, 'external_order_id', v_row.ext_id),
      'source_row_id', v_row.source_row_id,
      'target_row_id', v_row.target_row_id
    ));
  end loop;

  -- client_store_connections UNIQUE INDEX idx_store_connections_org_platform_url (org_id, platform, store_url)
  for v_row in
    select s.id as source_row_id, t.id as target_row_id, s.platform, s.store_url
    from client_store_connections s
    join client_store_connections t
      on t.platform = s.platform
     and t.store_url = s.store_url
     and t.org_id = p_target_org_id
    where s.org_id = p_source_org_id
  loop
    v_collisions := v_collisions || jsonb_build_array(jsonb_build_object(
      'table', 'client_store_connections',
      'constraint', 'idx_store_connections_org_platform_url',
      'key', jsonb_build_object('platform', v_row.platform, 'store_url', v_row.store_url),
      'source_row_id', v_row.source_row_id,
      'target_row_id', v_row.target_row_id
    ));
  end loop;

  -- client_store_connections UNIQUE INDEX idx_store_connections_org_discogs (org_id, platform) WHERE platform='discogs'
  for v_row in
    select s.id as source_row_id, t.id as target_row_id
    from client_store_connections s
    join client_store_connections t
      on t.platform = 'discogs'
     and t.org_id = p_target_org_id
    where s.org_id = p_source_org_id
      and s.platform = 'discogs'
  loop
    v_collisions := v_collisions || jsonb_build_array(jsonb_build_object(
      'table', 'client_store_connections',
      'constraint', 'idx_store_connections_org_discogs',
      'key', jsonb_build_object('platform', 'discogs'),
      'source_row_id', v_row.source_row_id,
      'target_row_id', v_row.target_row_id
    ));
  end loop;

  -- organization_aliases UNIQUE INDEX (LOWER(alias_name), workspace_id) — does NOT include org_id,
  -- so collision == both orgs already have an alias with the same name in the same workspace.
  for v_row in
    select s.id as source_row_id, t.id as target_row_id, s.alias_name
    from organization_aliases s
    join organization_aliases t
      on lower(t.alias_name) = lower(s.alias_name)
     and t.workspace_id is not distinct from s.workspace_id
     and t.org_id = p_target_org_id
    where s.org_id = p_source_org_id
  loop
    v_collisions := v_collisions || jsonb_build_array(jsonb_build_object(
      'table', 'organization_aliases',
      'constraint', 'idx_organization_aliases_name_ws',
      'key', jsonb_build_object('alias_name', v_row.alias_name),
      'source_row_id', v_row.source_row_id,
      'target_row_id', v_row.target_row_id
    ));
  end loop;

  return jsonb_build_object(
    'source_name',    v_source.name,
    'target_name',    v_target.name,
    'affected_rows',  v_affected,
    'total_affected', v_total,
    'collisions',     v_collisions
  );
end;
$$;

grant execute on function preview_merge_organizations(uuid, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- merge_organizations_txn
--
-- Transactional merge. Performs:
--   1. Sanity checks (orgs exist, workspaces match, no self-merge).
--   2. Re-runs collision detection — aborts with `merge_collisions_present` if any.
--   3. Reassigns every org_id-bearing table from source → target in the canonical order
--      defined in v_tables (warehouse_products FIRST so the inventory_levels trigger
--      sees the new owner when re-deriving).
--   4. Forces re-derivation on warehouse_inventory_levels by issuing a no-op UPDATE
--      that lets trg_derive_inventory_org_id recompute org_id from variant→product.
--   5. Reassigns parent_org_id pointers on child orgs.
--   6. DELETEs the source organization row.
--
-- Returns: total rows reassigned (sum of UPDATE rowcounts; does not include the
-- inventory-trigger touch step, which is idempotent).
--
-- Raises:
--   merge_invalid_input          (null inputs, self-merge)
--   merge_source_not_found       (source org missing)
--   merge_target_not_found       (target org missing)
--   merge_workspace_mismatch     (orgs in different workspaces)
--   merge_collisions_present     (UNIQUE conflicts detected — operator must resolve)
--   merge_delete_failed          (final source-org DELETE failed despite reassignment)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function merge_organizations_txn(
  p_source_org_id uuid,
  p_target_org_id uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preview jsonb;
  v_source record;
  v_target record;
  v_total int := 0;
  v_rowcount int;
  v_table text;
  v_tables text[] := array[
    'warehouse_products',
    'warehouse_shipments',
    'warehouse_orders',
    'warehouse_inbound_shipments',
    'warehouse_billing_snapshots',
    'warehouse_billing_adjustments',
    'warehouse_billing_rule_overrides',
    'warehouse_inventory_levels',
    'warehouse_shipstation_stores',
    'warehouse_review_queue',
    'bandcamp_connections',
    'client_store_connections',
    'mailorder_orders',
    'oauth_states',
    'shipstation_orders',
    'sku_sync_conflicts',
    'support_conversations',
    'support_email_mappings',
    'portal_admin_settings',
    'users',
    'organization_aliases'
  ];
begin
  if p_source_org_id is null or p_target_org_id is null then
    raise exception 'merge_invalid_input: source and target org ids are required';
  end if;
  if p_source_org_id = p_target_org_id then
    raise exception 'merge_invalid_input: source and target must differ';
  end if;

  select id, name, workspace_id into v_source
  from organizations where id = p_source_org_id for update;
  if v_source.id is null then
    raise exception 'merge_source_not_found: %', p_source_org_id;
  end if;

  select id, name, workspace_id into v_target
  from organizations where id = p_target_org_id for update;
  if v_target.id is null then
    raise exception 'merge_target_not_found: %', p_target_org_id;
  end if;

  if v_source.workspace_id is distinct from v_target.workspace_id then
    raise exception 'merge_workspace_mismatch: source workspace=% target workspace=%',
      v_source.workspace_id, v_target.workspace_id;
  end if;

  -- Re-check collisions inside the transaction (close the preview→confirm gap).
  v_preview := preview_merge_organizations(p_source_org_id, p_target_org_id);
  if jsonb_array_length(coalesce(v_preview->'collisions', '[]'::jsonb)) > 0 then
    raise exception 'merge_collisions_present: %', v_preview->'collisions';
  end if;

  -- Reassign in canonical order. warehouse_products MUST be first so the
  -- inventory_levels trigger derives the new owner on the subsequent pass.
  foreach v_table in array v_tables loop
    execute format('update %I set org_id = $1 where org_id = $2', v_table)
      using p_target_org_id, p_source_org_id;
    get diagnostics v_rowcount = row_count;
    v_total := v_total + v_rowcount;
  end loop;

  -- Force re-derivation on warehouse_inventory_levels. The previous loop already
  -- updated org_id directly, but the BEFORE trigger may have re-derived from
  -- variant→product → since warehouse_products is reassigned first in v_tables,
  -- the trigger should already produce the target id. This touch UPDATE is a
  -- belt-and-suspenders pass for any rows whose product chain changed mid-merge.
  update warehouse_inventory_levels
     set updated_at = now()
   where variant_id in (
     select id from warehouse_product_variants where org_id = p_target_org_id
   )
     and org_id is distinct from p_target_org_id;

  -- Move child organizations.
  update organizations
     set parent_org_id = p_target_org_id
   where parent_org_id = p_source_org_id;

  -- Delete the source org. All FKs are reassigned at this point; if any are
  -- missed (new org_id-bearing table added without updating v_tables), this
  -- DELETE will raise a foreign-key violation, surfaced as merge_delete_failed.
  begin
    delete from organizations where id = p_source_org_id;
  exception when foreign_key_violation then
    raise exception 'merge_delete_failed: orphan FK detected on source org % — add the missing table to merge_organizations_txn v_tables. SQLSTATE=%', p_source_org_id, sqlstate;
  end;

  return v_total;
end;
$$;

grant execute on function merge_organizations_txn(uuid, uuid) to service_role;

comment on function preview_merge_organizations(uuid, uuid) is
  'HRD-36: Returns affected row counts and UNIQUE-constraint collisions for an org→org merge. Read-only.';
comment on function merge_organizations_txn(uuid, uuid) is
  'HRD-36: Atomically reassigns every org_id-bearing row from source to target then deletes source. Aborts on collision (Rule #64).';
