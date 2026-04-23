/**
 * Phase 0 / §9.1 D4 — schema-probe test for the per-channel safety stock
 * migration. Source-level guard: asserts that the migration file at
 * `supabase/migrations/20260424000001_per_channel_safety_stock.sql` exists
 * and contains every contract clause the §9.6 D1 push helper depends on.
 *
 * We do NOT run the migration here — that requires a live Supabase project,
 * and the migration is exercised end-to-end by `supabase db push` + the
 * downstream helper tests. This test is the regression guard so a refactor
 * of the migration file can't silently drop a CHECK or column.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../supabase/migrations/20260424000001_per_channel_safety_stock.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("20260424000001_per_channel_safety_stock — schema contract", () => {
  it("adds safety_stock to client_store_sku_mappings as smallint NOT NULL DEFAULT 0", () => {
    expect(sql).toMatch(
      /ALTER TABLE client_store_sku_mappings\s+ADD COLUMN IF NOT EXISTS safety_stock smallint NOT NULL DEFAULT 0/,
    );
  });

  it("F-NF-X1: enforces safety_stock >= 0 via a named CHECK constraint (idempotent guard)", () => {
    // Constraint name MUST be stable so a re-run of the migration is a no-op
    // (the DO $$ block keys off pg_constraint.conname).
    expect(sql).toMatch(/conname = 'client_store_sku_mappings_safety_stock_nonneg'/);
    expect(sql).toMatch(
      /ADD CONSTRAINT client_store_sku_mappings_safety_stock_nonneg\s+CHECK \(safety_stock >= 0\)/,
    );
  });

  it("adds preorder_whitelist (boolean NOT NULL DEFAULT false) for the policy-audit DENY exemption", () => {
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS preorder_whitelist boolean NOT NULL DEFAULT false/,
    );
  });

  it("adds last_inventory_policy + last_policy_check_at for shopify-policy-audit persistence", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS last_inventory_policy text/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS last_policy_check_at timestamptz/);
  });

  it("creates the policy_drift partial index keyed on (CONTINUE && !preorder_whitelist)", () => {
    // The Channels page health card joins on this predicate; the partial
    // index keeps the lookup O(open-drift-rows) instead of O(all-mappings).
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_sku_mappings_policy_drift\s+ON client_store_sku_mappings\(connection_id\)\s+WHERE last_inventory_policy = 'CONTINUE' AND preorder_whitelist = false/,
    );
  });

  it("creates warehouse_safety_stock_per_channel with UNIQUE(workspace_id, variant_id, channel) and CHECK >= 0", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS warehouse_safety_stock_per_channel/);
    expect(sql).toMatch(/UNIQUE\(workspace_id, variant_id, channel\)/);
    expect(sql).toMatch(/safety_stock smallint NOT NULL DEFAULT 0 CHECK \(safety_stock >= 0\)/);
  });

  it("ENABLEs RLS on warehouse_safety_stock_per_channel + adds staff_all + client_select policies", () => {
    expect(sql).toMatch(/ALTER TABLE warehouse_safety_stock_per_channel ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /CREATE POLICY staff_all ON warehouse_safety_stock_per_channel\s+FOR ALL TO authenticated/,
    );
    expect(sql).toMatch(
      /CREATE POLICY client_select ON warehouse_safety_stock_per_channel\s+FOR SELECT TO authenticated/,
    );
    // Client SELECT must be variant→product→org scoped, not WS-scoped, so
    // clients only see their own org's safety reserves.
    expect(sql).toMatch(/p\.org_id = get_user_org_id\(\)/);
  });

  it("ends with NOTIFY pgrst, 'reload schema' so PostgREST picks up the columns immediately", () => {
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });

  it("is fully idempotent — every ALTER / CREATE uses IF NOT EXISTS or pg_constraint guard", () => {
    // Crude but effective: count the DDL verbs and assert each is wrapped
    // (other than RLS POLICY / NOTIFY which can't carry IF NOT EXISTS).
    const adds = sql.match(/ADD COLUMN/g) ?? [];
    const guardedAdds = sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(guardedAdds.length).toBe(adds.length);

    const creates = sql.match(/CREATE (TABLE|INDEX)/g) ?? [];
    const guardedCreates = sql.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) ?? [];
    expect(guardedCreates.length).toBe(creates.length);
  });
});
