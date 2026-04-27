-- Fix SKU matching alias writes after SKU-AUTO scope trigger rollout.
--
-- `client_store_product_identity_matches` has org_id, but the live alias table
-- `client_store_sku_mappings` does not. The original guard checked
-- `to_jsonb(NEW) ? 'org_id'` but still dereferenced `NEW.org_id`, which raises
-- "record \"new\" has no field \"org_id\"" on alias inserts/updates.

CREATE OR REPLACE FUNCTION enforce_identity_match_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_connection_workspace uuid;
  v_connection_org uuid;
  v_row_org uuid;
  v_variant_workspace uuid;
BEGIN
  SELECT workspace_id, org_id
    INTO v_connection_workspace, v_connection_org
    FROM client_store_connections
   WHERE id = NEW.connection_id;

  IF v_connection_workspace IS NULL THEN
    RAISE EXCEPTION 'enforce_identity_match_scope: connection % not found', NEW.connection_id;
  END IF;

  IF NEW.workspace_id <> v_connection_workspace THEN
    RAISE EXCEPTION 'enforce_identity_match_scope: workspace mismatch (row=%, connection=%)',
      NEW.workspace_id, v_connection_workspace;
  END IF;

  v_row_org := NULLIF(to_jsonb(NEW)->>'org_id', '')::uuid;
  IF v_row_org IS NOT NULL AND v_row_org <> v_connection_org THEN
    RAISE EXCEPTION 'enforce_identity_match_scope: org mismatch (row=%, connection=%)',
      v_row_org, v_connection_org;
  END IF;

  IF NEW.variant_id IS NOT NULL THEN
    SELECT workspace_id INTO v_variant_workspace
      FROM warehouse_product_variants
     WHERE id = NEW.variant_id;

    IF v_variant_workspace IS NULL THEN
      RAISE EXCEPTION 'enforce_identity_match_scope: variant % not found', NEW.variant_id;
    END IF;

    IF v_variant_workspace <> NEW.workspace_id THEN
      RAISE EXCEPTION 'enforce_identity_match_scope: variant workspace mismatch (variant=%, row=%)',
        v_variant_workspace, NEW.workspace_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_identity_match_scope() IS
  'Defense-in-depth tenancy guard for identity rows and live SKU aliases. Uses JSONB field extraction for optional org_id so client_store_sku_mappings, which has no org_id column, can still pass workspace/variant scope checks. Release gate SKU-AUTO-26.';

NOTIFY pgrst, 'reload schema';
