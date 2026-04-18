import { describe, expect, it } from "vitest";
import {
  buildGroupKey,
  detectCasingConflicts,
  detectClientStoreMismatches,
} from "@/trigger/tasks/sku-sync-audit";

/**
 * Phase 0.5 — pure-function tests for the audit detectors. The detectors
 * are extracted so we can validate detection logic without spinning up
 * Supabase or ShipStation clients.
 *
 * The "suggest, don't mutate" pattern (Phase 0 reinforcement #1) means
 * detection MUST be deterministic: the same DB state at two run times
 * must produce the same `group_key` so dedupe via UNIQUE(group_key) works.
 */

describe("buildGroupKey", () => {
  it("is deterministic across runs for the same inputs", () => {
    const a = buildGroupKey({
      workspace_id: "ws-1",
      conflict_type: "mismatch",
      primary: "SKU-A",
      secondary: "shopify:sku-a",
    });
    const b = buildGroupKey({
      workspace_id: "ws-1",
      conflict_type: "mismatch",
      primary: "SKU-A",
      secondary: "shopify:sku-a",
    });
    expect(a).toBe(b);
  });

  it("differs across workspaces even if the SKU pair is identical", () => {
    const a = buildGroupKey({
      workspace_id: "ws-1",
      conflict_type: "mismatch",
      primary: "SKU-A",
    });
    const b = buildGroupKey({
      workspace_id: "ws-2",
      conflict_type: "mismatch",
      primary: "SKU-A",
    });
    expect(a).not.toBe(b);
  });
});

describe("detectCasingConflicts", () => {
  it("flags variants that differ only in casing", () => {
    const conflicts = detectCasingConflicts([
      {
        id: "v1",
        workspace_id: "ws-1",
        sku: "LILA-AV1",
        title: "Foo",
        product_id: "p1",
        org_id: "o1",
      },
      {
        id: "v2",
        workspace_id: "ws-1",
        sku: "lila-av1",
        title: "Foo",
        product_id: "p1",
        org_id: "o1",
      },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflict_type).toBe("casing");
    expect(conflicts[0].severity).toBe("low");
    expect(conflicts[0].our_sku).toContain("LILA-AV1");
    expect(conflicts[0].our_sku).toContain("lila-av1");
  });

  it("does NOT flag exact-match duplicates (those would violate UNIQUE(workspace_id, sku))", () => {
    const conflicts = detectCasingConflicts([
      { id: "v1", workspace_id: "ws-1", sku: "EXACT", title: null, product_id: "p1", org_id: null },
      // Different workspace — different unique scope, so not a conflict here.
      { id: "v2", workspace_id: "ws-2", sku: "EXACT", title: null, product_id: "p2", org_id: null },
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("scopes conflicts to a single workspace", () => {
    const conflicts = detectCasingConflicts([
      { id: "v1", workspace_id: "ws-1", sku: "ABC", title: null, product_id: "p1", org_id: null },
      { id: "v2", workspace_id: "ws-2", sku: "abc", title: null, product_id: "p2", org_id: null },
    ]);
    // Same lowercased SKU but different workspaces = different unique
    // scopes, so neither pair counts as a conflict.
    expect(conflicts).toHaveLength(0);
  });
});

describe("detectClientStoreMismatches", () => {
  it("flags Squarespace SQ* placeholders as high severity placeholder_squarespace", () => {
    const conflicts = detectClientStoreMismatches([
      {
        workspace_id: "ws-1",
        variant_id: "v1",
        remote_sku: "SQ12345",
        variant_sku: "REAL-SKU",
        variant_title: "Title",
        variant_org_id: "o1",
        platform: "squarespace",
      },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflict_type).toBe("placeholder_squarespace");
    expect(conflicts[0].severity).toBe("high");
    expect(conflicts[0].squarespace_sku).toBe("SQ12345");
    expect(conflicts[0].our_sku).toBe("REAL-SKU");
  });

  it("flags non-Squarespace differences as medium-severity mismatch", () => {
    const conflicts = detectClientStoreMismatches([
      {
        workspace_id: "ws-1",
        variant_id: "v1",
        remote_sku: "SHOPIFY-SKU",
        variant_sku: "DB-SKU",
        variant_title: "Title",
        variant_org_id: "o1",
        platform: "shopify",
      },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflict_type).toBe("mismatch");
    expect(conflicts[0].severity).toBe("medium");
    expect(conflicts[0].shopify_sku).toBe("SHOPIFY-SKU");
  });

  it("ignores rows where remote_sku matches the variant SKU exactly", () => {
    const conflicts = detectClientStoreMismatches([
      {
        workspace_id: "ws-1",
        variant_id: "v1",
        remote_sku: "MATCH",
        variant_sku: "MATCH",
        variant_title: null,
        variant_org_id: null,
        platform: "shopify",
      },
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("ignores rows with null remote_sku (mapping never pushed)", () => {
    const conflicts = detectClientStoreMismatches([
      {
        workspace_id: "ws-1",
        variant_id: "v1",
        remote_sku: null,
        variant_sku: "DB-SKU",
        variant_title: null,
        variant_org_id: null,
        platform: "shopify",
      },
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("produces a stable group_key per (variant_sku, platform, remote_sku) tuple", () => {
    const a = detectClientStoreMismatches([
      {
        workspace_id: "ws-1",
        variant_id: "v1",
        remote_sku: "X",
        variant_sku: "Y",
        variant_title: null,
        variant_org_id: null,
        platform: "shopify",
      },
    ]);
    const b = detectClientStoreMismatches([
      {
        workspace_id: "ws-1",
        variant_id: "v1",
        remote_sku: "X",
        variant_sku: "Y",
        variant_title: null,
        variant_org_id: null,
        platform: "shopify",
      },
    ]);
    expect(a[0].group_key).toBe(b[0].group_key);
  });
});
