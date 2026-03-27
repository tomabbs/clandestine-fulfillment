-- Migration: Backfill stale org_id on warehouse_inventory_levels
--
-- Root cause: inventory_levels rows were created when warehouse_products.org_id
-- was null (before client onboarding assigned products to orgs). The trigger
-- trg_derive_inventory_org_id correctly derives org_id on INSERT/UPDATE of
-- inventory_levels, but it cannot retroactively fix rows created before the
-- org assignment was made. This one-time UPDATE re-derives org_id for all rows
-- where it no longer matches the current variant → product → org chain.
--
-- Scale: 550 total rows — single pass, no batching needed.
-- Safe to re-run: WHERE clause is idempotent (only touches mismatched rows).

UPDATE warehouse_inventory_levels wil
SET
  org_id    = wp.org_id,
  updated_at = now()
FROM warehouse_product_variants wpv
JOIN warehouse_products wp ON wp.id = wpv.product_id
WHERE wil.variant_id = wpv.id
  AND (wil.org_id IS DISTINCT FROM wp.org_id);

-- Verify: report count of updated rows
-- (PostgREST does not surface row counts from UPDATE, check via migration log)
