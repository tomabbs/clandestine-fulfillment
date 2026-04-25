-- Phase 0 — Pre-migration audit for SKU matching hardening.
-- Run against the linked production project before adding active-row unique
-- indexes. This surfaces duplicates that would block the migration.

-- 1) Canonical duplicate mappings: same connection + variant mapped multiple times.
select
  connection_id,
  variant_id,
  count(*) as row_count,
  array_agg(id order by updated_at desc, created_at desc) as mapping_ids
from client_store_sku_mappings
where is_active = true
group by connection_id, variant_id
having count(*) > 1
order by row_count desc, connection_id, variant_id;

-- 2) Remote duplicate mappings by inventory item id (Shopify strongest key).
select
  connection_id,
  remote_inventory_item_id,
  count(*) as row_count,
  array_agg(id order by updated_at desc, created_at desc) as mapping_ids
from client_store_sku_mappings
where is_active = true
  and remote_inventory_item_id is not null
group by connection_id, remote_inventory_item_id
having count(*) > 1
order by row_count desc, connection_id, remote_inventory_item_id;

-- 3) Remote duplicate mappings by remote variant id.
select
  connection_id,
  remote_variant_id,
  count(*) as row_count,
  array_agg(id order by updated_at desc, created_at desc) as mapping_ids
from client_store_sku_mappings
where is_active = true
  and remote_variant_id is not null
group by connection_id, remote_variant_id
having count(*) > 1
order by row_count desc, connection_id, remote_variant_id;

-- 4) Duplicate canonical SKUs within the warehouse truth for the same org.
select
  wp.workspace_id,
  wp.org_id,
  upper(trim(wpv.sku)) as canonical_sku,
  count(*) as row_count,
  array_agg(wpv.id order by wpv.updated_at desc, wpv.created_at desc) as variant_ids
from warehouse_product_variants wpv
inner join warehouse_products wp on wp.id = wpv.product_id
where wpv.sku is not null
  and trim(wpv.sku) <> ''
group by wp.workspace_id, wp.org_id, upper(trim(wpv.sku))
having count(*) > 1
order by row_count desc, wp.workspace_id, wp.org_id, canonical_sku;

-- 5) Summary counts for operator sign-off.
with canonical_dupes as (
  select connection_id, variant_id
  from client_store_sku_mappings
  where is_active = true
  group by connection_id, variant_id
  having count(*) > 1
),
remote_inventory_dupes as (
  select connection_id, remote_inventory_item_id
  from client_store_sku_mappings
  where is_active = true
    and remote_inventory_item_id is not null
  group by connection_id, remote_inventory_item_id
  having count(*) > 1
),
remote_variant_dupes as (
  select connection_id, remote_variant_id
  from client_store_sku_mappings
  where is_active = true
    and remote_variant_id is not null
  group by connection_id, remote_variant_id
  having count(*) > 1
),
canonical_sku_dupes as (
  select wp.workspace_id, wp.org_id, upper(trim(wpv.sku)) as canonical_sku
  from warehouse_product_variants wpv
  inner join warehouse_products wp on wp.id = wpv.product_id
  where wpv.sku is not null
    and trim(wpv.sku) <> ''
  group by wp.workspace_id, wp.org_id, upper(trim(wpv.sku))
  having count(*) > 1
)
select 'connection_variant_duplicates' as metric, count(*)::bigint as duplicate_groups from canonical_dupes
union all
select 'remote_inventory_item_duplicates' as metric, count(*)::bigint as duplicate_groups from remote_inventory_dupes
union all
select 'remote_variant_duplicates' as metric, count(*)::bigint as duplicate_groups from remote_variant_dupes
union all
select 'canonical_sku_duplicates' as metric, count(*)::bigint as duplicate_groups from canonical_sku_dupes;
