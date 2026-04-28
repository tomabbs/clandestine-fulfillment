-- Data-only seed for the Northern Spy Label Group Shopify umbrella store.
--
-- Primary coverage for Northern Spy Records is created by the schema
-- backfill/trigger. These rows add the other label orgs whose canonical
-- warehouse/Bandcamp products are intentionally sold through this Shopify
-- connection.

INSERT INTO client_store_connection_org_coverage (
  workspace_id,
  connection_id,
  org_id,
  coverage_role,
  notes
)
SELECT
  c.workspace_id,
  c.id,
  org_ids.org_id,
  'included_label'::coverage_role_t,
  org_ids.notes
FROM client_store_connections c
CROSS JOIN (
  VALUES
    (
      'c80d0a0a-377f-4165-91eb-da7cb12aa527'::uuid,
      'Northern Spy Label Group Shopify coverage: Egghunt Records'
    ),
    (
      '9657499f-35d5-4be4-8be2-8fc5844ae441'::uuid,
      'Northern Spy Label Group Shopify coverage: NNA Tapes'
    ),
    (
      'c1712b56-1705-43e5-a6e5-980d21681f24'::uuid,
      'Northern Spy Label Group Shopify coverage: Across the Horizon'
    )
) AS org_ids(org_id, notes)
JOIN organizations o
  ON o.id = org_ids.org_id
 AND o.workspace_id = c.workspace_id
WHERE c.id = '93225922-357f-4607-a5a4-2c1ad3a9beac'::uuid
  AND c.workspace_id = '1e59b9ca-ab4e-442b-952b-a649e2aadb0e'::uuid
ON CONFLICT (connection_id, org_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
