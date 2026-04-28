/**
 * Northern Spy Label Group SKU Matching — schema-probe tests.
 *
 * The live migration is applied with `supabase db push`; these source-level
 * guards keep the audit-critical table, triggers, RPC guard, and seed rows
 * from being weakened by future edits.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCHEMA_PATH = resolve(
  __dirname,
  "../../../supabase/migrations/20260428000008_client_store_connection_org_coverage.sql",
);
const SEED_PATH = resolve(
  __dirname,
  "../../../supabase/migrations/20260428000009_seed_northern_spy_label_group_coverage.sql",
);

const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
const seedSql = readFileSync(SEED_PATH, "utf8");

describe("20260428000008_client_store_connection_org_coverage — schema contract", () => {
  it("creates an explicit enum-backed coverage table with one row per covered org", () => {
    expect(schemaSql).toMatch(
      /CREATE TYPE coverage_role_t AS ENUM \('primary', 'included_label'\)/,
    );
    expect(schemaSql).toMatch(/CREATE TABLE IF NOT EXISTS client_store_connection_org_coverage/);
    expect(schemaSql).toMatch(/coverage_role coverage_role_t NOT NULL/);
    expect(schemaSql).toMatch(/UNIQUE \(connection_id, org_id\)/);
  });

  it("enforces exactly one primary coverage row per connection", () => {
    expect(schemaSql).toMatch(/client_store_connection_org_coverage_one_primary/);
    expect(schemaSql).toMatch(/WHERE coverage_role = 'primary'/);
  });

  it("uses a trigger to keep coverage rows scoped to the same workspace", () => {
    expect(schemaSql).toMatch(/enforce_client_store_connection_org_coverage_scope/);
    expect(schemaSql).toMatch(/NEW\.workspace_id <> v_connection_workspace/);
    expect(schemaSql).toMatch(/NEW\.workspace_id <> v_org_workspace/);
  });

  it("requires primary coverage orgs to equal client_store_connections.org_id", () => {
    expect(schemaSql).toMatch(/NEW\.coverage_role = 'primary' AND NEW\.org_id <> v_connection_org/);
    expect(schemaSql).toContain("primary org % must equal connection org %");
  });

  it("backfills and auto-creates primary coverage rows for one-org behavior", () => {
    expect(schemaSql).toMatch(/Backfilled primary coverage from client_store_connections\.org_id/);
    expect(schemaSql).toMatch(/ensure_primary_client_store_connection_org_coverage/);
    expect(schemaSql).toMatch(/AFTER INSERT ON client_store_connections/);
    expect(schemaSql).toMatch(/Auto-created primary coverage from client_store_connections insert/);
  });

  it("keeps v1 RLS staff-only and avoids client-facing coverage disclosure", () => {
    expect(schemaSql).toMatch(
      /ALTER TABLE client_store_connection_org_coverage ENABLE ROW LEVEL SECURITY/,
    );
    expect(schemaSql).toMatch(/CREATE POLICY staff_all_client_store_connection_org_coverage/);
    expect(schemaSql).not.toContain("client_select");
  });

  it("guards persist_sku_match against direct uncovered-org RPC calls", () => {
    expect(schemaSql).toMatch(/CREATE OR REPLACE FUNCTION persist_sku_match/);
    expect(schemaSql).toMatch(/JOIN warehouse_products wp ON wp\.id = wpv\.product_id/);
    expect(schemaSql).toMatch(/client_store_connection_org_coverage coverage/);
    expect(schemaSql).toMatch(/persist_sku_match: variant org not covered by connection/);
  });
});

describe("20260428000009_seed_northern_spy_label_group_coverage — seed contract", () => {
  it("seeds only included-label coverage for the Northern Spy Shopify connection", () => {
    expect(seedSql).toMatch(/93225922-357f-4607-a5a4-2c1ad3a9beac/);
    expect(seedSql).toMatch(/'included_label'::coverage_role_t/);
    expect(seedSql).not.toMatch(/'primary'::coverage_role_t/);
  });

  it("seeds Egghunt, NNA Tapes, and Across the Horizon by explicit org IDs", () => {
    expect(seedSql).toMatch(/c80d0a0a-377f-4165-91eb-da7cb12aa527/);
    expect(seedSql).toMatch(/9657499f-35d5-4be4-8be2-8fc5844ae441/);
    expect(seedSql).toMatch(/c1712b56-1705-43e5-a6e5-980d21681f24/);
  });

  it("keeps the seed idempotent and workspace scoped", () => {
    expect(seedSql).toMatch(/o\.workspace_id = c\.workspace_id/);
    expect(seedSql).toMatch(/1e59b9ca-ab4e-442b-952b-a649e2aadb0e/);
    expect(seedSql).toMatch(/ON CONFLICT \(connection_id, org_id\) DO NOTHING/);
  });
});
