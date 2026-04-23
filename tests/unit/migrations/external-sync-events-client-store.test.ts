/**
 * Phase 1 §9.2 D1/D2 — schema-probe test for the external_sync_events
 * extension migration. The new per-platform per-SKU push tasks
 * (`client-store-push-on-sku`, `clandestine-shopify-push-on-sku`) acquire
 * idempotency rows on `external_sync_events`. The pre-Phase-1 CHECK
 * constraints would reject the new (system, action) tuples; this test pins
 * that the migration extends both constraints AND keeps every previously
 * allowed value (no regression on existing call sites).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../supabase/migrations/20260424000003_external_sync_events_client_store.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("20260424000003_external_sync_events_client_store — schema contract", () => {
  it("drops the old system CHECK constraint by name (idempotent re-run)", () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS external_sync_events_system_check/);
  });

  it("drops the old action CHECK constraint by name (idempotent re-run)", () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS external_sync_events_action_check/);
  });

  it("re-adds system CHECK including ALL pre-existing values (regression guard)", () => {
    for (const sysName of ["shipstation_v1", "shipstation_v2", "bandcamp", "clandestine_shopify"]) {
      expect(sql).toMatch(new RegExp(`'${sysName}'`));
    }
  });

  it("system CHECK admits the three new client_store_* systems for per-SKU push", () => {
    for (const sysName of [
      "client_store_shopify",
      "client_store_squarespace",
      "client_store_woocommerce",
    ]) {
      expect(sql).toMatch(new RegExp(`'${sysName}'`));
    }
  });

  it("re-adds action CHECK including ALL pre-existing actions (regression guard)", () => {
    for (const action of [
      "increment",
      "decrement",
      "adjust",
      "modify",
      "alias_add",
      "alias_remove",
      "sku_rename",
    ]) {
      expect(sql).toMatch(new RegExp(`'${action}'`));
    }
  });

  it("action CHECK admits the new `set` action for absolute-quantity pushes", () => {
    expect(sql).toMatch(/'set'/);
  });

  it("ends with NOTIFY pgrst so PostgREST picks up the wider shape immediately", () => {
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });

  it("adds COMMENT explanations on both extended constraints (audit trail)", () => {
    expect(sql).toMatch(
      /COMMENT ON CONSTRAINT external_sync_events_system_check ON external_sync_events/,
    );
    expect(sql).toMatch(
      /COMMENT ON CONSTRAINT external_sync_events_action_check ON external_sync_events/,
    );
  });

  it("does NOT remove or rename the UNIQUE constraint on (system, correlation_id, sku, action)", () => {
    expect(sql).not.toMatch(/DROP CONSTRAINT.*external_sync_events.*unique/i);
    expect(sql).not.toMatch(/ALTER TABLE.*external_sync_events.*DROP UNIQUE/i);
  });
});
