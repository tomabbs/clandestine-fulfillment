-- Operational cutover — sample read-only queries (2026-04-28)
--
-- Sanity-check staging data for mapping/coverage completeness narratives.
-- Replace :connection_id / :workspace_id with real UUIDs before running.

-- Active SKU mappings for one store connection
-- SELECT count(*) AS active_mappings
-- FROM client_store_sku_mappings m
-- WHERE m.connection_id = :connection_id AND m.is_active = true;

-- Connection org vs coverage rows (expect exactly one primary matching c.org_id)
-- SELECT c.org_id AS connection_default_org, cov.org_id, cov.coverage_role
-- FROM client_store_connections c
-- LEFT JOIN client_store_connection_org_coverage cov
--   ON cov.connection_id = c.id
-- WHERE c.id = :connection_id;
