-- Northern Spy Label Group / umbrella storefront coverage substrate.
--
-- A client_store_connection still has one owner org_id for billing, portal,
-- and order ownership. This table defines the additional product-owner orgs
-- whose warehouse variants may be matched to that same storefront connection.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'coverage_role_t') THEN
    CREATE TYPE coverage_role_t AS ENUM ('primary', 'included_label');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS client_store_connection_org_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  coverage_role coverage_role_t NOT NULL,
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, org_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS client_store_connection_org_coverage_one_primary
  ON client_store_connection_org_coverage (connection_id)
  WHERE coverage_role = 'primary';

CREATE INDEX IF NOT EXISTS idx_connection_org_coverage_org
  ON client_store_connection_org_coverage (workspace_id, org_id);

CREATE OR REPLACE FUNCTION enforce_client_store_connection_org_coverage_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_connection_workspace uuid;
  v_connection_org uuid;
  v_org_workspace uuid;
BEGIN
  SELECT workspace_id, org_id
    INTO v_connection_workspace, v_connection_org
    FROM client_store_connections
   WHERE id = NEW.connection_id;

  IF v_connection_workspace IS NULL THEN
    RAISE EXCEPTION 'client_store_connection_org_coverage: connection % not found', NEW.connection_id;
  END IF;

  SELECT workspace_id
    INTO v_org_workspace
    FROM organizations
   WHERE id = NEW.org_id;

  IF v_org_workspace IS NULL THEN
    RAISE EXCEPTION 'client_store_connection_org_coverage: org % not found', NEW.org_id;
  END IF;

  IF NEW.workspace_id <> v_connection_workspace THEN
    RAISE EXCEPTION 'client_store_connection_org_coverage: workspace mismatch (row=%, connection=%)',
      NEW.workspace_id, v_connection_workspace;
  END IF;

  IF NEW.workspace_id <> v_org_workspace THEN
    RAISE EXCEPTION 'client_store_connection_org_coverage: org workspace mismatch (row=%, org=%)',
      NEW.workspace_id, v_org_workspace;
  END IF;

  IF NEW.coverage_role = 'primary' AND NEW.org_id <> v_connection_org THEN
    RAISE EXCEPTION 'client_store_connection_org_coverage: primary org % must equal connection org %',
      NEW.org_id, v_connection_org;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_client_store_connection_org_coverage_scope_trg
  ON client_store_connection_org_coverage;
CREATE TRIGGER enforce_client_store_connection_org_coverage_scope_trg
  BEFORE INSERT OR UPDATE ON client_store_connection_org_coverage
  FOR EACH ROW EXECUTE FUNCTION enforce_client_store_connection_org_coverage_scope();

INSERT INTO client_store_connection_org_coverage (
  workspace_id,
  connection_id,
  org_id,
  coverage_role,
  notes
)
SELECT
  workspace_id,
  id,
  org_id,
  'primary'::coverage_role_t,
  'Backfilled primary coverage from client_store_connections.org_id'
FROM client_store_connections
ON CONFLICT (connection_id, org_id) DO NOTHING;

CREATE OR REPLACE FUNCTION ensure_primary_client_store_connection_org_coverage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO client_store_connection_org_coverage (
    workspace_id,
    connection_id,
    org_id,
    coverage_role,
    notes
  )
  VALUES (
    NEW.workspace_id,
    NEW.id,
    NEW.org_id,
    'primary'::coverage_role_t,
    'Auto-created primary coverage from client_store_connections insert'
  )
  ON CONFLICT (connection_id, org_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_store_connections_primary_coverage_trg
  ON client_store_connections;
CREATE TRIGGER client_store_connections_primary_coverage_trg
  AFTER INSERT ON client_store_connections
  FOR EACH ROW EXECUTE FUNCTION ensure_primary_client_store_connection_org_coverage();

ALTER TABLE client_store_connection_org_coverage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_all_client_store_connection_org_coverage
  ON client_store_connection_org_coverage;
CREATE POLICY staff_all_client_store_connection_org_coverage
  ON client_store_connection_org_coverage
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

CREATE OR REPLACE FUNCTION persist_sku_match(
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
  p_match_reasons jsonb DEFAULT '[]'::jsonb,
  p_candidate_snapshot jsonb DEFAULT '{}'::jsonb,
  p_candidate_fingerprint text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mapping_id uuid;
  v_actor_role text;
  v_canonical_sku text;
  v_variant_org_id uuid;
BEGIN
  SELECT wpv.sku, wp.org_id
    INTO v_canonical_sku, v_variant_org_id
    FROM warehouse_product_variants wpv
    JOIN warehouse_products wp ON wp.id = wpv.product_id
   WHERE wpv.id = p_variant_id
     AND wpv.workspace_id = p_workspace_id;

  IF v_canonical_sku IS NULL THEN
    RAISE EXCEPTION 'persist_sku_match: variant % not found in workspace %', p_variant_id, p_workspace_id;
  END IF;

  IF v_variant_org_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM client_store_connection_org_coverage coverage
     WHERE coverage.workspace_id = p_workspace_id
       AND coverage.connection_id = p_connection_id
       AND coverage.org_id = v_variant_org_id
  ) THEN
    RAISE EXCEPTION 'persist_sku_match: variant org not covered by connection';
  END IF;

  SELECT role INTO v_actor_role
  FROM users
  WHERE id = p_actor_id;

  UPDATE client_store_sku_mappings
  SET
    is_active = false,
    deactivated_by = p_actor_id,
    deactivated_at = now(),
    deactivation_reason = 'superseded_by_persist_sku_match',
    updated_at = now()
  WHERE connection_id = p_connection_id
    AND is_active = true
    AND id <> coalesce(v_mapping_id, gen_random_uuid())
    AND (
      variant_id = p_variant_id
      OR (p_remote_inventory_item_id IS NOT NULL AND remote_inventory_item_id = p_remote_inventory_item_id)
      OR (p_remote_variant_id IS NOT NULL AND remote_variant_id = p_remote_variant_id)
    );

  SELECT id
  INTO v_mapping_id
  FROM client_store_sku_mappings
  WHERE connection_id = p_connection_id
    AND (
      variant_id = p_variant_id
      OR (p_remote_inventory_item_id IS NOT NULL AND remote_inventory_item_id = p_remote_inventory_item_id)
      OR (p_remote_variant_id IS NOT NULL AND remote_variant_id = p_remote_variant_id)
    )
  ORDER BY is_active DESC, updated_at DESC, created_at DESC
  LIMIT 1;

  IF v_mapping_id IS NULL THEN
    INSERT INTO client_store_sku_mappings (
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
    VALUES (
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
    RETURNING id INTO v_mapping_id;
  ELSE
    UPDATE client_store_sku_mappings
    SET
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
    WHERE id = v_mapping_id;
  END IF;

  INSERT INTO sku_mapping_events (
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
  VALUES (
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

  RETURN v_mapping_id;
END;
$$;

COMMENT ON TABLE client_store_connection_org_coverage IS
  'Defines product-owner organizations whose canonical variants may be matched to a client store connection. The connection org_id remains the owner/billing/order org; coverage expands staff SKU Matching scope only.';

COMMENT ON FUNCTION persist_sku_match(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, jsonb, jsonb, text, text
) IS
  'Persists a live SKU alias for a client store connection. Enforces that the selected variant product org is covered by client_store_connection_org_coverage before writing client_store_sku_mappings.';

NOTIFY pgrst, 'reload schema';
