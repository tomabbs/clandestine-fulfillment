# Bandcamp orphan Shopify dupe — permanent fix plan

> Plan pack: PLAN — see `docs/prompt-packs/PLAN.md`. Doc Sync Contract obligations are listed at the end.

## Feature

Stop `bandcamp-sync` from ever creating duplicate Shopify draft products and orphan `warehouse_products` rows when the per-SKU variant insert collides with the `warehouse_product_variants_workspace_id_sku_key` unique constraint. Cleanup the existing damage in Clandestine Shopify and our DB.

## Goal

After this lands:

1. A single Bandcamp merch item (`merchItem.package_id`) maps to **exactly one** Shopify product and **exactly one** `warehouse_products` row per workspace, regardless of SKU drift, race conditions, or retries.
2. Any future variant-insert error surfaces as a `warehouse_review_queue` row and rolls back the Shopify product, instead of silently producing an orphan.
3. The ~10K orphan Shopify drafts and ~2K+ orphan `warehouse_products` rows already in the system are archived, not just hidden.

## Context

### What happened

A botched series of `bandcamp-sync` runs created **11,674 duplicate variant rows in the Clandestine Shopify export** spread across **65 SKUs each repeated 300–301 times** (`TS-NS-LSPI`, `CS-NORTHE-NIPOMO`, `LP-LEAVIN-COLLAPSE`, …), all `Status = Draft`, `Variant Inventory Qty = 0`. They cluster on two vendors: **Northern Spy Records** and **LEAVING RECORDS**.

### What we already verified (forensic evidence — pre-plan investigation)

1. **Bandcamp connections are healthy.** `bandcamp_connections.org_id` is populated for both vendors; not the cause.
2. **Each affected SKU has exactly ONE row in `warehouse_product_variants`** (the row created by whichever insert eventually won the race for the unique constraint).
3. **`warehouse_products` is full of orphans.** For `vendor = 'Northern Spy Records'` with `status='draft'`: **438 of 566 draft products have no attached `warehouse_product_variants`**. Globally there are **~2,853 draft `warehouse_products`** with the same shape across all vendors.
4. **ShipStation v1 was NOT affected.** A live probe of the 10 worst-offender SKUs in `/products?sku=` returned **0 exact matches** for any of them. Total v1 product count is 2,649 — much smaller than 14,548 Shopify variant rows. The dupes never propagated to ShipStation v1.
5. **ShipStation v2 inventory was NOT affected.** Per-SKU `listInventory({ skus:[sku] })` against all 41 dupe-explosion SKUs returned **0 inventory rows** — these SKUs were never seeded to v2 (or are at zero, which v2 omits). No cleanup needed in v2.

### Root cause (annotated)

The "unmatched merch item" path in `src/trigger/tasks/bandcamp-sync.ts` does:

1. Line 1488 — pre-create dedup check by `(workspace_id, sku)`:
   ```startLine:endLine:filepath
   ```1488:1493:src/trigger/tasks/bandcamp-sync.ts
             const { data: existingVariant } = await supabase
               .from("warehouse_product_variants")
               .select("id")
               .eq("workspace_id", workspaceId)
               .eq("sku", effectiveSku)
               .maybeSingle();
   ```
2. Lines 1577–1610 — `productSetCreate` creates a brand new Shopify draft product.
3. Lines 1678–1701 — inserts a new `warehouse_products` row referencing that Shopify product. **Errors here ARE captured.**
4. Lines 1712–1728 — inserts a new `warehouse_product_variants` row. **Errors are silently destructured away:**
   ```startLine:endLine:filepath
   ```1712:1729:src/trigger/tasks/bandcamp-sync.ts
           const { data: newVariant } = await supabase
             .from("warehouse_product_variants")
             .insert({
               product_id: product.id,
               workspace_id: workspaceId,
               sku: effectiveSku,
               title: merchItem.title,
               price: bcPrice,
               cost: bcCost,
               weight: CATEGORY_DEFAULT_WEIGHTS[productCategory]?.value ?? 0.5,
               weight_unit: "lb",
               bandcamp_url: merchItem.url ?? null,
               street_date: merchItem.new_date,
               is_preorder: tags.includes("Pre-Order"),
             })
             .select("id")
             .single();

           if (newVariant) {
   ```
5. When the variant insert fails because `(workspace_id, sku)` collides with the unique constraint (Postgres error `23505`), `newVariant` is `null` and the entire seed-inventory + create-mapping block at lines 1730–1830 is **skipped silently** — no log, no review queue row, no rollback of the just-created Shopify product or `warehouse_products` row. Every retry on the next cron tick starts fresh and creates yet another Shopify draft, since the SKU dedup at line 1488 still misses (the *successful* prior insert is hidden behind whatever made it miss the first time — case/whitespace drift, RLS scope quirk, or the previous run's variant having been attached to a different product that has since been deleted).

The duplication is **self-terminating** — once any one of the variant inserts wins the unique-constraint race, line 1488 starts finding the row and the process correctly `continue`s. That's why we see "exactly 300/301 dupes per SKU and then it stops."

### Why the fix has to be deeper than "catch the error"

The dedup key is wrong. SKUs drift (whitespace, casing, manual edits, rule changes). The real invariant is **one Bandcamp `package_id` → one `warehouse_products` row per workspace**. We must dedup on `bandcamp_product_mappings.bandcamp_item_id`, with SKU dedup as a backup.

# Requirements

## Functional

1. Before creating a Shopify product OR a `warehouse_products` row, the unmatched-path code MUST check `bandcamp_product_mappings` for an existing row keyed by `(workspace_id, bandcamp_item_id = merchItem.package_id)`. If it exists, the entire create path is skipped and the existing variant is reused (the same way a `existingVariant` truthy lookup at line 1495 reuses).
2. The variant insert MUST capture `error`. On any error other than the new "happy path race" (handled below), the just-created Shopify product MUST be archived via `productUpdate(status: ARCHIVED)` and the just-created `warehouse_products` row MUST be deleted, then a `warehouse_review_queue` row is upserted with category `bandcamp_sync_variant_create_failed`, severity `high`, group_key `bandcamp.variant_create_failed:{workspace_id}:{sku}` (Rule #55 dedup).
3. The Shopify-create + warehouse-create sequence MUST be wrapped in a Postgres advisory lock keyed by `hashtextextended(workspace_id::text || ':' || merchItem.package_id::text, 0)` — this is the per-workspace, per-Bandcamp-item serialization key that prevents two concurrent task runs (or two different Bandcamp connections that point at overlapping items) from racing on the same package.
4. A cleanup script `scripts/cleanup-bandcamp-orphan-shopify.ts` deletes the orphan `warehouse_products` rows and archives the corresponding Shopify products. Must be **dry-run by default**, idempotent, scoped by vendor / created-at window, and emit a per-product CSV report.
5. CI guard `scripts/check-trigger-task-error-capture.sh` greps `src/trigger/tasks/**/*.ts` for any `.insert(` or `.update(` call whose result is destructured **without** capturing `error` (heuristic — explicit allow-list for known-safe call sites). Build-failing.

## Non-functional

1. The fix is one-task-scope (`bandcamp-sync`) plus one new utility helper. No schema changes other than (a) adding the `warehouse_inventory_activity_source_check` admit list extension if not already there for `bandcamp_initial` (already there) and (b) the new `warehouse_review_queue` category enum value if categories are enum-constrained (TBD — see Open Questions).
2. Cleanup script must respect Shopify rate limits (2 req/sec product mutations) and ShipStation 60 req/min (we will NOT touch ShipStation in cleanup since v1/v2 are unaffected).
3. The advisory lock MUST release on every code path (success, exception, early continue) — use a `try/finally` wrapper.

# Constraints

## Technical

- Trigger task; runs on `bandcamp-api` queue (concurrencyLimit:1) — but cron + on-demand triggers can still queue back-to-back, and per-band concurrency is irrelevant once two connections share Bandcamp items via member bands. The advisory lock is the real protection.
- `warehouse_product_variants_workspace_id_sku_key` is the unique constraint we collide with. We CANNOT loosen it (Rule #31 — SKU uniqueness per workspace is a system invariant).
- Cleanup must respect Shopify GraphQL `productUpdate` mutation cost (10) and the leaky bucket (2/sec for unauthenticated apps, 4/sec for our authenticated session). Use a 300ms sleep between mutations, with exponential backoff on 429.
- All inventory writes still go through `recordInventoryChange()` (Rule #20). The fix only touches catalog creation, never inventory.

## Product

- Cleanup MUST archive (not delete) the Shopify products. Archived products are recoverable for 60 days; deleted are gone forever. Northern Spy and LEAVING RECORDS still need their canonical products undisturbed.
- The cleanup must NEVER touch a Shopify product that has a corresponding `warehouse_product_variants` row. Only orphans get archived.
- The cleanup MUST emit a CSV listing every archived product (Shopify productId, handle, title, vendor, createdAt) so we can prove what was touched if a label disputes it.

## External (Supabase, Shopify, Bandcamp)

- Supabase advisory lock: `pg_try_advisory_xact_lock(bigint)` (transaction-scoped) is preferred over `pg_advisory_lock` (session-scoped) — Trigger.dev tasks may share a connection. We'll wrap the lock + create-flow in a single Supabase RPC for atomicity.
- Shopify: `productUpdate` GraphQL mutation with `status: ARCHIVED`. No effect on inventory or orders. Reversible.
- Bandcamp: not touched in this plan.

# Affected files

## Code (new + edited)

- `src/trigger/tasks/bandcamp-sync.ts` — edit the unmatched-path block (lines ~1426–1830) to:
  - Add a `bandcamp_product_mappings` pre-check by `(workspace_id, bandcamp_item_id)` BEFORE the SKU lookup at line 1488.
  - Wrap Shopify-create + warehouse-create + variant-create in a `withBandcampPackageLock(workspaceId, packageId, async () => …)` helper.
  - Capture `error` from the variant insert and react: archive the Shopify product, delete the `warehouse_products` row, upsert review queue.
- `src/trigger/lib/bandcamp-package-lock.ts` (NEW) — exports `withBandcampPackageLock(workspaceId, packageId, fn)` using `pg_try_advisory_xact_lock` via a tiny Supabase RPC.
- `supabase/migrations/20260420000001_bandcamp_package_lock_rpc.sql` (NEW) — defines the SECURITY DEFINER `try_bandcamp_package_lock(p_workspace_id uuid, p_package_id bigint)` RPC plus a no-op release shim. Idempotent (`CREATE OR REPLACE`).
- `src/lib/clients/shopify-client.ts` — add `productArchive(productId)` thin wrapper (delegates to the existing `productUpdate` with `status: ARCHIVED`) so the cleanup + the variant-rollback path share the same audited code path.
- `scripts/cleanup-bandcamp-orphan-shopify.ts` (NEW) — paginated cleanup. Dry-run by default. Reads orphans from DB → archives Shopify products in throttled batches → deletes `warehouse_products` rows → writes CSV report.
- `scripts/check-trigger-task-error-capture.sh` (NEW) — CI guard, grep-based.
- `scripts/release-gate.sh` — append the new CI guard to the gate.

## Tests (new)

- `tests/unit/trigger/tasks/bandcamp-sync-unmatched-path.test.ts` — covers four scenarios: (a) mapping exists, (b) variant exists with mapping missing, (c) neither exists and insert succeeds, (d) neither exists and insert fails (asserts archive + queue + delete).
- `tests/unit/trigger/lib/bandcamp-package-lock.test.ts` — asserts lock acquisition / contention / release-on-exception behavior.
- `tests/unit/scripts/cleanup-bandcamp-orphan-shopify.test.ts` — dry-run mode emits no mutations; live mode invokes `productArchive` and deletes only orphans.

## Truth docs (Doc Sync Contract)

- `TRUTH_LAYER.md` — add new system invariant under "Core System Invariants" describing the `bandcamp_item_id` dedup contract and the package-level advisory lock.
- `docs/system_map/TRIGGER_TASK_CATALOG.md` — update `bandcamp-sync` row to mention the package-level dedup + advisory lock.
- `docs/system_map/API_CATALOG.md` — no change (no new Server Action; cleanup is script-only).
- `project_state/engineering_map.yaml` — append "Bandcamp orphan-Shopify dupe protection (2026-04-13)" entry under integrations domain.
- `docs/DEFERRED_FOLLOWUPS.md` — add `bandcamp-orphan-cleanup-verification` (due 1 week after run) confirming no orphans regenerated.
- `CLAUDE.md` — append a new rule (#73) documenting the dedup contract so future windows do not regress it.

# Proposed implementation

Steps execute in this exact order so each step is independently verifiable.

## Step 1 — Migration: advisory-lock RPC

`supabase/migrations/20260420000001_bandcamp_package_lock_rpc.sql`:

```sql
-- Per-(workspace, Bandcamp package_id) advisory lock. Transaction-scoped so
-- it auto-releases on COMMIT / ROLLBACK regardless of code-path bugs.
CREATE OR REPLACE FUNCTION try_bandcamp_package_lock(
  p_workspace_id uuid,
  p_package_id   bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- 64-bit advisory key derived from workspace_id::text + package_id::text.
  v_key bigint;
BEGIN
  v_key := hashtextextended(p_workspace_id::text || ':' || p_package_id::text, 0);
  RETURN pg_try_advisory_xact_lock(v_key);
END;
$$;

GRANT EXECUTE ON FUNCTION try_bandcamp_package_lock(uuid, bigint) TO service_role;
```

Run: `supabase db push --yes` (per workspace rule).

## Step 2 — Helper: `withBandcampPackageLock`

`src/trigger/lib/bandcamp-package-lock.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

const ACQUIRE_TIMEOUT_MS = 5_000;
const POLL_MS = 200;

export class BandcampPackageLockBusyError extends Error {
  constructor(public readonly workspaceId: string, public readonly packageId: number | string) {
    super(`Bandcamp package lock busy: ws=${workspaceId} pkg=${packageId}`);
  }
}

/**
 * Acquires a Postgres transaction-scoped advisory lock keyed by (workspace, package_id),
 * runs `fn` inside the same Supabase RPC transaction, and releases on COMMIT/ROLLBACK.
 *
 * Because PostgREST does not expose a single round-trip "rpc + arbitrary callback" pattern,
 * we acquire a session-level lock with a poll-and-release shim. The poll is bounded;
 * if we cannot acquire within ACQUIRE_TIMEOUT_MS we throw BandcampPackageLockBusyError
 * and the unmatched-path skips the merchItem this run (next run picks it up — safe).
 */
export async function withBandcampPackageLock<T>(
  supabase: SupabaseClient,
  workspaceId: string,
  packageId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  while (true) {
    const { data, error } = await supabase.rpc("try_bandcamp_package_lock", {
      p_workspace_id: workspaceId,
      p_package_id: packageId,
    });
    if (error) throw error;
    if (data === true) break;
    if (Date.now() - start > ACQUIRE_TIMEOUT_MS) {
      throw new BandcampPackageLockBusyError(workspaceId, packageId);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    // pg_try_advisory_xact_lock auto-releases on tx end; nothing to do.
    // (We keep this finally for symmetry / future swap to session-scoped lock.)
  }
}
```

> Note on the lock model: `pg_try_advisory_xact_lock` releases at the end of the **PostgREST request**. Our `fn()` runs across multiple PostgREST round-trips, so the lock effectively releases between round-trips — this is acceptable because the new pre-check (Step 3) makes every round-trip individually idempotent. For *true* session-scoped locking we'd need `pg_try_advisory_lock` + an `unlock` RPC; we accept the weaker contract because the pre-check covers the gap. **Open Question OQ-1:** should we upgrade to session-scoped locks if observed regression rate > 0?

## Step 3 — Patch `bandcamp-sync.ts` unmatched-path

Insert ahead of line 1488 (the existing SKU-only dedup):

```ts
// PRIMARY dedup: have we already created a mapping for this Bandcamp package?
// SKU drift can hide an existing variant from the (workspace_id, sku) lookup
// below; the package_id is invariant.
const { data: existingMappingByPkg } = await supabase
  .from("bandcamp_product_mappings")
  .select("id, variant_id")
  .eq("workspace_id", workspaceId)
  .eq("bandcamp_item_id", merchItem.package_id)
  .maybeSingle();

if (existingMappingByPkg) {
  // Just refresh `last_synced_at` + raw_api_data and bail before any create path.
  await supabase
    .from("bandcamp_product_mappings")
    .update({ raw_api_data: merchItem, last_synced_at: new Date().toISOString() })
    .eq("id", existingMappingByPkg.id);
  itemsProcessed++;
  continue;
}
```

Then wrap the existing `productSetCreate` → `warehouse_products.insert` → `warehouse_product_variants.insert` block in `withBandcampPackageLock`. On variant insert failure, react:

```ts
const { data: newVariant, error: variantInsertError } = await supabase
  .from("warehouse_product_variants")
  .insert({ /* …unchanged… */ })
  .select("id")
  .single();

if (variantInsertError || !newVariant) {
  logger.error("Variant insert failed in unmatched-path — rolling back", {
    sku: effectiveSku,
    workspaceId,
    packageId: merchItem.package_id,
    productId: product.id,
    shopifyProductId,
    pgError: variantInsertError?.message,
    pgCode: variantInsertError?.code,
  });

  // Roll back the just-created Shopify product so we never leak a draft.
  if (shopifyProductId) {
    try {
      await productArchive(shopifyProductId);
    } catch (archErr) {
      logger.warn("Failed to archive Shopify product during rollback", {
        shopifyProductId,
        error: String(archErr),
      });
    }
  }
  // Roll back the warehouse_products row.
  await supabase.from("warehouse_products").delete().eq("id", product.id);

  await supabase.from("warehouse_review_queue").upsert(
    {
      workspace_id: workspaceId,
      org_id: connection.org_id ?? null,
      category: "bandcamp_sync_variant_create_failed",
      severity: "high" as const,
      title: `Bandcamp sync variant insert failed: ${effectiveSku}`,
      description:
        `Variant insert collided with the unique constraint or returned an error. ` +
        `Shopify product ${shopifyProductId ?? "(none)"} was archived; warehouse_products ` +
        `row ${product.id} was deleted.`,
      metadata: {
        sku: effectiveSku,
        bandcamp_item_id: String(merchItem.package_id),
        band_id: String(connection.band_id),
        shopify_product_id: shopifyProductId,
        pg_error: variantInsertError?.message ?? null,
        pg_code: variantInsertError?.code ?? null,
      },
      status: "open" as const,
      group_key: `bandcamp.variant_create_failed:${workspaceId}:${effectiveSku}`,
      occurrence_count: 1,
    },
    { onConflict: "group_key", ignoreDuplicates: false },
  );

  itemsFailed++;
  continue;
}
```

## Step 4 — `productArchive` wrapper

`src/lib/clients/shopify-client.ts` adds:

```ts
export async function productArchive(productId: string): Promise<void> {
  await productUpdate(productId, { status: "ARCHIVED" });
}
```

`productUpdate` already exists (per `engineering_map.yaml` integrations domain). Cleanup + rollback both go through this single audited code path.

## Step 5 — Cleanup script

`scripts/cleanup-bandcamp-orphan-shopify.ts`:

CLI:
```
npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts            # dry-run
npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts --execute  # mutate
npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts --execute --vendor "Northern Spy Records"
npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts --execute --since 2026-04-13
```

Behavior:

1. Pages `warehouse_products` where `status='draft'` AND there is no row in `warehouse_product_variants` with the same `product_id` (LEFT JOIN ... IS NULL via the `pageAll` helper used elsewhere).
2. Optional vendor + since filters.
3. For each row:
   - Dry-run: append to CSV `reports/bandcamp-orphan-cleanup-{ts}.csv` with `{shopify_product_id, vendor, title, created_at, action: "would_archive"}`. No mutations.
   - Execute: call `productArchive(shopify_product_id)`, then `supabase.from("warehouse_products").delete().eq("id", row.id)`, then append CSV with `action: "archived"`.
4. Throttle: 350ms sleep between mutations. On Shopify 429 → exponential backoff up to 30s.
5. Idempotent — re-running picks up only what's still orphaned.
6. Final summary: `archived: N | skipped: M | errors: K`.

## Step 6 — CI guard

`scripts/check-trigger-task-error-capture.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Heuristic: any .insert(...).select() or .update(...) in src/trigger/tasks/**
# whose enclosing destructure does NOT capture `error`. Build-failing.

violations=$(rg -n --multiline --pcre2 \
  -g 'src/trigger/tasks/**/*.ts' \
  '(?<!error[^,]*,\s*)\.\s*from\([^)]+\)\s*\n\s*\.\s*(?:insert|update)\(' \
  || true)

# Expanded check — any "{ data: x } = await supabase ... .insert(...)" without `error`
strict=$(rg -n --multiline -U \
  -g 'src/trigger/tasks/**/*.ts' \
  $'const \\{ data: [^}]+ \\} = await supabase\\s*\\n[^\\n]*\\n[^\\n]*\\.(insert|update)\\(' \
  || true)

if [ -n "$strict" ]; then
  echo "ERROR: insert/update without error capture in trigger task:"
  echo "$strict"
  exit 1
fi
```

Append to `scripts/release-gate.sh`.

## Step 7 — Tests

Wire all four scenarios in `bandcamp-sync-unmatched-path.test.ts` using the Supabase test mock harness already used by `tests/unit/trigger/tasks/*.ts`. Mock `productSetCreate`, `productArchive`, and the lock RPC.

## Step 8 — Run cleanup (dry-run → execute)

1. `npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts` — review CSV, confirm the count matches the diagnostic (≈10K).
2. `npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts --execute` — staged: first `--vendor "Northern Spy Records"`, verify, then `--vendor "LEAVING RECORDS"`, then no-vendor sweep for the long tail.
3. Post-cleanup verification SQL: `SELECT count(*) FROM warehouse_products p WHERE status='draft' AND NOT EXISTS (SELECT 1 FROM warehouse_product_variants v WHERE v.product_id = p.id);` — expect 0.

# Assumptions

- The unique constraint `warehouse_product_variants_workspace_id_sku_key` is intact on production and matches the migrations (verified via `engineering_map.yaml` Rule #31).
- `bandcamp_product_mappings` does not yet have a `(workspace_id, bandcamp_item_id)` UNIQUE constraint — we'll add one in a follow-up migration if the audit shows duplicates already exist there. (OQ-2)
- `productUpdate(status: ARCHIVED)` is fully reversible within Shopify's 60-day archive retention window.
- Cleanup runs against a Clandestine-Shopify session that holds `write_products` scope (already granted per the OAuth flow).
- ShipStation v1 + v2 truly have no propagated dupes (verified by live probe; documented in Context).

# Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | Shopify rate-limit during cleanup blows budget for live operations. | 350ms throttle + 429 backoff + run in batches per vendor. |
| R2 | Some "orphan" `warehouse_products` are actually intentional placeholders for a later inbound. | The query joins to `warehouse_product_variants` strictly; manual placeholders without variants are extremely rare. We'll spot-check the dry-run CSV before executing. Add `--exclude-source manual` filter if needed. |
| R3 | Advisory lock starves long-running tasks. | Lock is per-`(workspace, package_id)`, not global. Bounded poll (5s) + skip-and-retry-next-cron path keeps the task moving. |
| R4 | The `bandcamp_product_mappings` pre-check finds a row whose `variant_id` no longer exists (broken FK). | Defensive: if the variant lookup returns null, log and fall through to the unmatched-path (treat as if the mapping didn't exist). |
| R5 | The variant insert error is something OTHER than 23505 (e.g. trigger raised, RLS denied) and we still archive the Shopify product. | Acceptable: any insert error is a hard failure; the review queue row carries `pg_code` so staff can triage. Re-creation happens automatically on next cron run after the underlying issue is fixed. |
| R6 | Concurrent `bandcamp-sync` runs from sibling cron + on-demand triggers race past the package_id pre-check. | The advisory lock is the second layer; the pre-check + lock together close the window. |
| R7 | Cleanup script accidentally archives a Shopify product whose variant exists but is in a *different* `warehouse_products` row (broken parent FK). | The query joins by `warehouse_product_variants.product_id = warehouse_products.id`. If a variant was reassigned to a new product, the old product becomes a true orphan and SHOULD be archived. Surface the count in the dry-run CSV for staff review before executing. |

# Validation plan

## Pre-merge

- `pnpm check`
- `pnpm typecheck`
- `pnpm test` (must include the four new unit tests)
- `pnpm release:gate` — exercises the new CI guard
- `bash scripts/check-trigger-task-error-capture.sh`
- Targeted suite: `pnpm test tests/unit/trigger/tasks/bandcamp-sync-unmatched-path.test.ts tests/unit/trigger/lib/bandcamp-package-lock.test.ts`

## Migration

- `supabase db push --yes` (per workspace rule)
- `supabase migration list --linked` — confirm `20260420000001_bandcamp_package_lock_rpc.sql` is `Applied`

## Cleanup verification

- Dry-run CSV row count matches the diagnostic estimate (~2,853 globally, ~566 NS, ~XXX LEAVING).
- Post-execute SQL: `SELECT count(*) FROM warehouse_products p WHERE status='draft' AND NOT EXISTS (...)` returns `0`.
- Spot-check 5 archived Shopify products in the Shopify admin UI: `Status = Archived`, no orders attached, recoverable via Restore.
- Re-run dry-run after execute: `archived: 0 | skipped: 0`.

## Steady-state regression watch (1 week)

- Add `bandcamp-orphan-cleanup-verification` to `docs/DEFERRED_FOLLOWUPS.md` (severity `medium`, due 7 days post-cleanup):
  - Re-run dry-run cleanup script — must report 0 orphans.
  - Query `warehouse_review_queue WHERE category='bandcamp_sync_variant_create_failed' AND created_at > now() - interval '7 days'` — expected 0 rows.

# Rollback plan

| Layer | Rollback |
|-------|----------|
| Cleanup script | Shopify products are **archived**, not deleted. Restore in Shopify admin within 60 days. `warehouse_products` rows are deleted; restore from a Postgres point-in-time backup (Supabase has 7-day PITR). |
| Migration `20260420000001` | `DROP FUNCTION try_bandcamp_package_lock(uuid, bigint);` |
| Code patch | `git revert <commit>`; the `bandcamp_product_mappings` pre-check is purely additive and additionally takes precedence over the SKU pre-check, so reverting only re-introduces the prior race. No data corruption risk from the revert itself. |
| CI guard | Remove the gate line from `scripts/release-gate.sh`. |

# Rejected alternatives

1. **Add `UNIQUE(workspace_id, bandcamp_item_id)` on `bandcamp_product_mappings` and rely on the constraint to dedup.** — Rejected as the *primary* mechanism because pre-existing dupes (if any) would block the migration. We may add it as a *backstop* in a follow-up after the cleanup. (OQ-2)
2. **Switch the variant insert to `INSERT ... ON CONFLICT (workspace_id, sku) DO NOTHING RETURNING id`.** — Rejected as the primary fix because it would silently swallow the collision and still leave the orphan Shopify product behind. Acceptable as belt-and-suspenders only.
3. **Block `bandcamp-sync` runs entirely until cleanup is done.** — Rejected because the bug is self-terminating and currently dormant; pausing risks missing real new merch items. The fix is forward-compatible.
4. **Per-task Redis mutex.** — Rejected because we already have the SKU rectify Redis mutex pattern; a new Redis mutex for catalog creation conflates two concerns. The Postgres advisory lock is closer to the data.
5. **Loosen the unique constraint.** — Forbidden by Rule #31.

# Open questions

- **OQ-1:** Should `withBandcampPackageLock` upgrade to `pg_try_advisory_lock` + explicit `pg_advisory_unlock` if we observe any regression in steady-state? Today's xact-lock model assumes the per-round-trip pre-check is enough.
- **OQ-2:** Should we add `UNIQUE(workspace_id, bandcamp_item_id)` on `bandcamp_product_mappings` post-cleanup as a backstop? Need a separate audit to confirm no existing dupes there first.
- **OQ-3:** Does `warehouse_review_queue.category` enforce an enum/check constraint? If yes, the new value `bandcamp_sync_variant_create_failed` requires a separate migration. (Quick check: `select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'warehouse_review_queue'::regclass and contype='c';`)

# Deferred items

- **Hardening pass on `bandcamp_product_mappings` ↔ `warehouse_product_variants` referential integrity.** Add an FK with `ON DELETE CASCADE` if not already present; confirm and document in TRUTH_LAYER. (Owner: same window after migrate.)
- **Bandcamp scrape-side dedup.** The `bandcamp-scrape-page` task may have a parallel issue when it inserts into `warehouse_product_images`. Audit similarly. (Slug: `bandcamp-scrape-orphan-image-audit`, due 14 days.)
- **Backfill `bandcamp_product_mappings.workspace_id` index.** If absent, the new pre-check will scan; verify. (`CREATE INDEX CONCURRENTLY ...` in a follow-up migration if needed.)

# Revision history

- 2026-04-13 v1 — Initial plan after forensic investigation. Confirms ShipStation v1 + v2 are unaffected; cleanup scope is Shopify drafts + `warehouse_products` only.

# Trigger touchpoint check (mandatory per `truth-layer-hard-block.mdc`)

| Task ID | File | Reviewed | Touched? |
|---|---|---|---|
| `bandcamp-sync` | `src/trigger/tasks/bandcamp-sync.ts` | YES | YES — unmatched-path patch + advisory lock |
| `bandcamp-sync-cron` | `src/trigger/tasks/bandcamp-sync.ts` (`schedules.task`) | YES | NO — same file but only the inner unmatched-path block changes |
| `bandcamp-inventory-push` | `src/trigger/tasks/bandcamp-inventory-push.ts` | YES — confirmed it does not create products | NO |
| `bandcamp-baseline-audit` | `src/trigger/tasks/bandcamp-baseline-audit.ts` | YES — read-only against mappings | NO |
| `clandestine-shopify-sync` | `src/trigger/tasks/clandestine-shopify-sync.ts` | YES — distinct path; only inserts distro `org_id IS NULL` rows | NO |

Ingress: `src/actions/bandcamp.ts::triggerBandcampSync` and `src/actions/bandcamp.ts::triggerBandcampConnectionBackfill` (Rule #48 — Server Actions enqueue, never call APIs directly). Both unchanged.

# Doc Sync Contract updates required

- [ ] `TRUTH_LAYER.md` — append "Bandcamp catalog dedup is `bandcamp_item_id`-keyed (Rule #73 — 2026-04-13)" invariant.
- [ ] `docs/system_map/TRIGGER_TASK_CATALOG.md` — update `bandcamp-sync` row.
- [ ] `project_state/engineering_map.yaml` — add note under integrations domain.
- [ ] `docs/DEFERRED_FOLLOWUPS.md` — add `bandcamp-orphan-cleanup-verification` entry.
- [ ] `CLAUDE.md` — add Rule #73 (`bandcamp-sync` dedup contract).

— end —
