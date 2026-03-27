-- ============================================================================
-- V7.2 SCHEMA UPDATES
-- Complete migration for fulfillment + mail-order + Discogs integration
-- Includes all safety fixes from reviews
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SECTION 1: WAREHOUSE_ORDERS UPDATES
-- ----------------------------------------------------------------------------

-- Add metadata column
ALTER TABLE warehouse_orders 
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_orders_metadata 
  ON warehouse_orders USING gin(metadata);

-- Rename shopify_order_id to external_order_id
ALTER TABLE warehouse_orders 
  RENAME COLUMN shopify_order_id TO external_order_id;

ALTER INDEX IF EXISTS idx_orders_shopify 
  RENAME TO idx_orders_external;

-- Add platform fulfillment status tracking (H4 fix)
ALTER TABLE warehouse_orders 
  ADD COLUMN IF NOT EXISTS platform_fulfillment_status text 
  DEFAULT 'pending' 
  CHECK (platform_fulfillment_status IN ('pending', 'sent', 'confirmed', 'failed'));

-- Update source CHECK constraint to include discogs
ALTER TABLE warehouse_orders 
  DROP CONSTRAINT IF EXISTS warehouse_orders_source_check;
ALTER TABLE warehouse_orders 
  ADD CONSTRAINT warehouse_orders_source_check 
  CHECK (source IN ('shopify', 'bandcamp', 'woocommerce', 'squarespace', 'discogs', 'manual'));

-- ----------------------------------------------------------------------------
-- SECTION 2: MAIL-ORDER SYSTEM
-- ----------------------------------------------------------------------------

-- Mail-order orders (Clandestine Shopify + Clandestine Discogs)
CREATE TABLE IF NOT EXISTS mailorder_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  
  -- Source identification
  source text NOT NULL CHECK (source IN ('clandestine_shopify', 'clandestine_discogs')),
  external_order_id text NOT NULL,
  order_number text,
  
  -- Customer info
  customer_name text,
  customer_email text,
  
  -- Order details
  financial_status text,
  fulfillment_status text DEFAULT 'unfulfilled',
  platform_fulfillment_status text DEFAULT 'pending' 
    CHECK (platform_fulfillment_status IN ('pending', 'sent', 'confirmed', 'failed')),
  
  -- Pricing (keep subtotal separate for payout calculation)
  subtotal numeric NOT NULL,           -- Sum of line_items (product prices only)
  shipping_amount numeric DEFAULT 0,   -- Shipping charged to customer
  total_price numeric NOT NULL,        -- subtotal + shipping + taxes
  currency text DEFAULT 'USD',
  
  line_items jsonb NOT NULL DEFAULT '[]',
  shipping_address jsonb,
  
  -- Consignment tracking
  -- IMPORTANT: client_payout_amount = subtotal * 0.5 (NOT total_price)
  client_payout_amount numeric,
  client_payout_status text DEFAULT 'pending' 
    CHECK (client_payout_status IN ('pending', 'included_in_snapshot', 'paid')),
  client_payout_snapshot_id uuid,
  
  -- Metadata
  metadata jsonb DEFAULT '{}',
  
  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz,
  
  UNIQUE(workspace_id, source, external_order_id)
);

CREATE INDEX idx_mailorder_org ON mailorder_orders(org_id);
CREATE INDEX idx_mailorder_source ON mailorder_orders(source);
CREATE INDEX idx_mailorder_created ON mailorder_orders(created_at DESC);
CREATE INDEX idx_mailorder_payout_status ON mailorder_orders(client_payout_status);
CREATE INDEX idx_mailorder_fulfillment ON mailorder_orders(fulfillment_status);

-- ----------------------------------------------------------------------------
-- SECTION 3: WAREHOUSE_SHIPMENTS UPDATE (Dual FK with NOT VALID)
-- ----------------------------------------------------------------------------

-- Step 1: Add mailorder_id FK (safe)
ALTER TABLE warehouse_shipments 
  ADD COLUMN IF NOT EXISTS mailorder_id uuid REFERENCES mailorder_orders(id);

CREATE INDEX IF NOT EXISTS idx_shipments_mailorder ON warehouse_shipments(mailorder_id);

-- Step 2: Add constraint with NOT VALID (C12 fix - doesn't validate existing rows)
-- This prevents migration crash on legacy/orphan shipments
ALTER TABLE warehouse_shipments 
  DROP CONSTRAINT IF EXISTS chk_shipment_source;
ALTER TABLE warehouse_shipments 
  ADD CONSTRAINT chk_shipment_source CHECK (
    (order_id IS NOT NULL AND mailorder_id IS NULL) OR
    (order_id IS NULL AND mailorder_id IS NOT NULL)
  ) NOT VALID;

-- Note: Run this separately AFTER cleaning up legacy data:
-- ALTER TABLE warehouse_shipments VALIDATE CONSTRAINT chk_shipment_source;

-- ----------------------------------------------------------------------------
-- SECTION 4: CLIENT STORE CONNECTIONS UPDATES
-- ----------------------------------------------------------------------------

-- Add metadata column
ALTER TABLE client_store_connections 
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';

-- Add token refresh locking
ALTER TABLE client_store_connections 
  ADD COLUMN IF NOT EXISTS token_refresh_locked_at timestamptz;

-- Update platform CHECK constraint to include discogs
ALTER TABLE client_store_connections 
  DROP CONSTRAINT IF EXISTS client_store_connections_platform_check;
ALTER TABLE client_store_connections 
  ADD CONSTRAINT client_store_connections_platform_check 
  CHECK (platform IN ('shopify', 'woocommerce', 'squarespace', 'bigcommerce', 'discogs'));

-- Add unique indexes for OAuth upsert operations
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_connections_org_platform_url 
  ON client_store_connections(org_id, platform, store_url);

CREATE UNIQUE INDEX IF NOT EXISTS idx_store_connections_org_discogs 
  ON client_store_connections(org_id, platform) 
  WHERE platform = 'discogs';

-- ----------------------------------------------------------------------------
-- SECTION 5: OAUTH STATES (for OAuth 1.0a flows)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_token text NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  request_token_secret text NOT NULL,
  platform text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

CREATE INDEX idx_oauth_states_token ON oauth_states(oauth_token);
CREATE INDEX idx_oauth_states_expires ON oauth_states(expires_at);

-- ----------------------------------------------------------------------------
-- SECTION 6: EASYPOST / SCAN FORMS
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scan_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  easypost_batch_id text NOT NULL,
  easypost_scan_form_id text NOT NULL,
  form_url text NOT NULL,
  tracking_codes text[] NOT NULL,
  label_count integer NOT NULL,
  ship_date date NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'printed', 'voided')),
  printed_at timestamptz,
  printed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_scan_forms_date ON scan_forms(ship_date DESC);
CREATE INDEX idx_scan_forms_batch ON scan_forms(easypost_batch_id);

CREATE TABLE IF NOT EXISTS easypost_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  shipment_id uuid NOT NULL REFERENCES warehouse_shipments(id),
  easypost_shipment_id text NOT NULL UNIQUE,
  tracking_number text NOT NULL,
  carrier text NOT NULL,
  service text NOT NULL,
  label_url text NOT NULL,
  label_format text DEFAULT 'PNG',
  rate_amount numeric NOT NULL,
  batch_id uuid REFERENCES scan_forms(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_easypost_labels_shipment ON easypost_labels(shipment_id);
CREATE INDEX idx_easypost_labels_batch ON easypost_labels(batch_id);
CREATE INDEX idx_easypost_labels_unbatched ON easypost_labels(created_at) 
  WHERE batch_id IS NULL;

-- ----------------------------------------------------------------------------
-- SECTION 7: PRODUCT VARIANT UPDATES (Media Mail eligibility)
-- ----------------------------------------------------------------------------

ALTER TABLE warehouse_product_variants 
  ADD COLUMN IF NOT EXISTS media_mail_eligible boolean DEFAULT true;

ALTER TABLE warehouse_product_variants 
  ADD COLUMN IF NOT EXISTS hs_tariff_code text DEFAULT '8523.80';

-- ----------------------------------------------------------------------------
-- SECTION 8: DISCOGS MASTER CATALOG
-- ----------------------------------------------------------------------------

-- Discogs credentials (Clandestine master account)
CREATE TABLE IF NOT EXISTS discogs_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  
  -- Discogs account info
  username text NOT NULL,
  user_id integer,
  
  -- Authentication (Personal Access Token)
  access_token text NOT NULL,
  
  -- Default settings
  currency text DEFAULT 'USD',
  default_condition text DEFAULT 'Mint (M)',
  default_sleeve_condition text DEFAULT 'Mint (M)',
  default_allow_offers boolean DEFAULT true,
  target_listing_count integer DEFAULT 2,
  
  -- Timestamps
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  UNIQUE(workspace_id)
);

-- Discogs product mappings (SKU → Discogs release)
CREATE TABLE IF NOT EXISTS discogs_product_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  
  -- Warehouse reference
  product_id uuid NOT NULL REFERENCES warehouse_products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  
  -- Discogs reference
  discogs_release_id integer NOT NULL,
  discogs_master_id integer,
  discogs_release_url text,
  
  -- Match metadata
  match_method text NOT NULL CHECK (match_method IN ('barcode', 'catno', 'title', 'manual')),
  match_confidence decimal(3,2) CHECK (match_confidence >= 0 AND match_confidence <= 1),
  matched_at timestamptz DEFAULT now(),
  matched_by uuid REFERENCES users(id),
  
  -- Listing defaults
  condition text DEFAULT 'Mint (M)',
  sleeve_condition text DEFAULT 'Mint (M)',
  listing_price decimal(10,2),
  allow_offers boolean DEFAULT true,
  listing_comments text,
  
  -- Sync settings
  target_listing_count integer DEFAULT 2,
  is_active boolean DEFAULT true,
  
  -- Timestamps
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  UNIQUE(workspace_id, variant_id)
);

CREATE INDEX idx_discogs_mappings_release ON discogs_product_mappings(workspace_id, discogs_release_id);
CREATE INDEX idx_discogs_mappings_product ON discogs_product_mappings(product_id);

-- Discogs listings (active listings on Discogs)
CREATE TABLE IF NOT EXISTS discogs_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mapping_id uuid NOT NULL REFERENCES discogs_product_mappings(id) ON DELETE CASCADE,
  
  -- Discogs reference
  discogs_listing_id bigint NOT NULL UNIQUE,
  
  -- Listing state
  status text DEFAULT 'For Sale' CHECK (status IN ('For Sale', 'Draft', 'Sold', 'Deleted')),
  price decimal(10,2),
  condition text,
  sleeve_condition text,
  
  -- Timestamps
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  sold_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX idx_discogs_listings_mapping ON discogs_listings(mapping_id, status);

-- Discogs order messages (for deduplication)
CREATE TABLE IF NOT EXISTS discogs_order_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  
  discogs_order_id text NOT NULL,
  message_hash text NOT NULL, -- SHA256 for dedup
  
  timestamp timestamptz NOT NULL,
  from_username text NOT NULL,
  from_type text NOT NULL CHECK (from_type IN ('buyer', 'seller')),
  message_type text NOT NULL CHECK (message_type IN ('message', 'status', 'shipping')),
  message_text text,
  
  support_message_id uuid REFERENCES support_messages(id),
  
  created_at timestamptz DEFAULT now(),
  
  UNIQUE(workspace_id, message_hash)
);

CREATE INDEX idx_discogs_messages_order ON discogs_order_messages(workspace_id, discogs_order_id);

-- Discogs to support conversation mapping
CREATE TABLE IF NOT EXISTS discogs_support_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  
  discogs_order_id text NOT NULL,
  discogs_buyer_username text NOT NULL,
  discogs_buyer_id integer,
  
  support_conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  
  order_status text,
  last_message_check_at timestamptz,
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  UNIQUE(workspace_id, discogs_order_id)
);

CREATE INDEX idx_discogs_support_conversation ON discogs_support_mappings(support_conversation_id);

-- ----------------------------------------------------------------------------
-- SECTION 9: RLS POLICIES
-- ----------------------------------------------------------------------------

-- mailorder_orders
ALTER TABLE mailorder_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON mailorder_orders;
DROP POLICY IF EXISTS client_select ON mailorder_orders;
CREATE POLICY staff_all ON mailorder_orders FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON mailorder_orders FOR SELECT TO authenticated 
  USING (org_id = get_user_org_id());

-- oauth_states
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON oauth_states;
CREATE POLICY staff_all ON oauth_states FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());

-- scan_forms
ALTER TABLE scan_forms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON scan_forms;
CREATE POLICY staff_all ON scan_forms FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());

-- easypost_labels
ALTER TABLE easypost_labels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON easypost_labels;
CREATE POLICY staff_all ON easypost_labels FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());

-- discogs_credentials
ALTER TABLE discogs_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON discogs_credentials;
CREATE POLICY staff_all ON discogs_credentials FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());

-- discogs_product_mappings
ALTER TABLE discogs_product_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON discogs_product_mappings;
CREATE POLICY staff_all ON discogs_product_mappings FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());

-- discogs_listings
ALTER TABLE discogs_listings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON discogs_listings;
CREATE POLICY staff_all ON discogs_listings FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());

-- discogs_order_messages
ALTER TABLE discogs_order_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON discogs_order_messages;
CREATE POLICY staff_all ON discogs_order_messages FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());

-- discogs_support_mappings
ALTER TABLE discogs_support_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON discogs_support_mappings;
CREATE POLICY staff_all ON discogs_support_mappings FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());

-- ----------------------------------------------------------------------------
-- SECTION 10: CLEANUP
-- ----------------------------------------------------------------------------

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
