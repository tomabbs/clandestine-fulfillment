-- Bandcamp API Complete: capture 100% of API data, authority lifecycle, sales history
-- Plan: bandcamp_api_complete_9ce4d810.plan.md

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. New columns on bandcamp_product_mappings
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_subdomain text,
  ADD COLUMN IF NOT EXISTS bandcamp_album_title text,
  ADD COLUMN IF NOT EXISTS bandcamp_price numeric,
  ADD COLUMN IF NOT EXISTS bandcamp_currency text,
  ADD COLUMN IF NOT EXISTS bandcamp_is_set_price boolean,
  ADD COLUMN IF NOT EXISTS bandcamp_options jsonb,
  ADD COLUMN IF NOT EXISTS bandcamp_origin_quantities jsonb,
  ADD COLUMN IF NOT EXISTS bandcamp_catalog_number text,
  ADD COLUMN IF NOT EXISTS bandcamp_upc text,
  ADD COLUMN IF NOT EXISTS bandcamp_option_skus text[],
  ADD COLUMN IF NOT EXISTS raw_api_data jsonb;

-- Authority lifecycle: governs which fields can be auto-overwritten by sync
-- bandcamp_initial = BC owns everything (default for new items)
-- warehouse_reviewed = staff has reviewed; warehouse owns SKU/qty/price/dates
-- warehouse_locked = explicit lock; no auto-overwrites at all
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bandcamp_product_mappings' AND column_name = 'authority_status'
  ) THEN
    ALTER TABLE bandcamp_product_mappings
      ADD COLUMN authority_status text NOT NULL DEFAULT 'bandcamp_initial'
        CHECK (authority_status IN ('bandcamp_initial','warehouse_reviewed','warehouse_locked'));
  END IF;
END $$;

-- GIN index for option-level SKU lookups
CREATE INDEX IF NOT EXISTS idx_mappings_option_skus
  ON bandcamp_product_mappings USING GIN (bandcamp_option_skus)
  WHERE bandcamp_option_skus IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Sales transaction table (all-time history from Sales Report API v4)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bandcamp_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid REFERENCES bandcamp_connections(id),
  bandcamp_transaction_id bigint NOT NULL,
  bandcamp_transaction_item_id bigint NOT NULL,
  bandcamp_related_transaction_id bigint,
  sale_date timestamptz NOT NULL,
  item_type text,
  item_name text,
  artist text,
  album_title text,
  package text,
  option_name text,
  sku text,
  catalog_number text,
  upc text,
  isrc text,
  item_url text,
  currency text,
  item_price numeric,
  quantity integer,
  sub_total numeric,
  shipping numeric,
  tax numeric,
  seller_tax numeric,
  marketplace_tax numeric,
  tax_rate numeric,
  transaction_fee numeric,
  fee_type text,
  item_total numeric,
  amount_received numeric,
  net_amount numeric,
  additional_fan_contribution numeric,
  discount_code text,
  collection_society_share numeric,
  buyer_name text,
  buyer_email text,
  buyer_phone text,
  buyer_note text,
  ship_to_name text,
  ship_to_street text,
  ship_to_street_2 text,
  ship_to_city text,
  ship_to_state text,
  ship_to_zip text,
  ship_to_country text,
  ship_to_country_code text,
  ship_date timestamptz,
  ship_notes text,
  ship_from_country_name text,
  paid_to text,
  payment_state text,
  referer text,
  referer_url text,
  country text,
  country_code text,
  region_or_state text,
  city text,
  paypal_transaction_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, bandcamp_transaction_id, bandcamp_transaction_item_id)
);

CREATE INDEX IF NOT EXISTS idx_bandcamp_sales_workspace_date
  ON bandcamp_sales (workspace_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_bandcamp_sales_sku
  ON bandcamp_sales (workspace_id, sku)
  WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bandcamp_sales_catalog_number
  ON bandcamp_sales (workspace_id, catalog_number)
  WHERE catalog_number IS NOT NULL;

ALTER TABLE bandcamp_sales ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read sales"
  ON bandcamp_sales FOR SELECT
  USING (true);

CREATE POLICY "Service role manages sales"
  ON bandcamp_sales FOR ALL
  USING (true)
  WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Backfill progress tracking per connection
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bandcamp_sales_backfill_state (
  connection_id uuid PRIMARY KEY REFERENCES bandcamp_connections(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed')),
  last_processed_date timestamptz,
  earliest_sale_date timestamptz,
  latest_sale_date timestamptz,
  total_transactions integer DEFAULT 0,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bandcamp_sales_backfill_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read backfill state"
  ON bandcamp_sales_backfill_state FOR SELECT
  USING (true);

CREATE POLICY "Service role manages backfill state"
  ON bandcamp_sales_backfill_state FOR ALL
  USING (true)
  WITH CHECK (true);
