-- Migration 007: Bandcamp credentials, connections, product mappings

CREATE TABLE bandcamp_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  client_id text NOT NULL,
  client_secret text NOT NULL,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bandcamp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  band_id bigint NOT NULL,
  band_name text,
  band_url text,
  is_active boolean DEFAULT true,
  member_bands_cache jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, band_id)
);
CREATE INDEX idx_bandcamp_connections_org ON bandcamp_connections(org_id);

CREATE TABLE bandcamp_product_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  bandcamp_item_id bigint,
  bandcamp_item_type text CHECK (bandcamp_item_type IN ('album', 'package', 'track')),
  bandcamp_member_band_id bigint,
  bandcamp_type_name text,
  bandcamp_new_date date,
  bandcamp_url text,
  last_quantity_sold integer,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bandcamp_mappings_variant ON bandcamp_product_mappings(variant_id);
