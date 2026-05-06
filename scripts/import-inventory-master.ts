/**
 * Import physical warehouse baseline counts from the inventory master workbook.
 *
 * Dry-run:
 *   npx tsx scripts/import-inventory-master.ts --workspace-id <uuid> --file reports/inventory-master/foo.xlsx --dry-run
 *
 * Apply:
 *   npx tsx scripts/import-inventory-master.ts --workspace-id <uuid> --file reports/inventory-master/foo.xlsx --apply --cycle-id 2026-q2-count --import-run-id run-001
 */

import { config } from "dotenv";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as XLSX from "xlsx";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

type ImportMode = "dry_run" | "apply";

type CliArgs = {
  workspaceId: string | null;
  file: string | null;
  mode: ImportMode | null;
  cycleId: string | null;
  importRunId: string | null;
  correctionRun: boolean;
  allowBundleParentCounts: boolean;
  outDir: string;
};

type WorkbookRow = Record<string, unknown> & {
  "Row #"?: number;
  SKU?: string;
  "NEW COUNT"?: unknown;
  "_variant_id"?: string;
  "_workspace_id"?: string;
};

type ValidationStatus =
  | "valid"
  | "blank_count"
  | "duplicate_variant_id"
  | "duplicate_sku"
  | "invalid_count"
  | "negative_count"
  | "unknown_variant"
  | "ambiguous_sku"
  | "wrong_workspace"
  | "archived_or_deleted"
  | "count_in_progress"
  | "bundle_parent_rejected";

type RowResult = {
  rowNumber: number;
  sku: string | null;
  variantId: string | null;
  orgId: string | null;
  status: ValidationStatus | "applied" | "already_processed" | "no_change" | "error";
  previousAvailable: number | null;
  newCount: number | null;
  delta: number | null;
  reason?: string;
  correlationId?: string;
};

type VariantRecord = {
  id: string;
  workspace_id: string;
  sku: string;
  title: string | null;
  count_status: string | null;
  available: number;
  org_id: string | null;
  product_status: string | null;
  is_bundle_parent: boolean;
};

type ImportReport = {
  workspaceId: string;
  mode: ImportMode;
  cycleId: string | null;
  importRunId: string | null;
  workbook: {
    path: string;
    filename: string;
    checksumSha256: string;
  };
  generatedAt: string;
  summary: {
    rowsRead: number;
    validRows: number;
    appliedRows: number;
    noChangeRows: number;
    alreadyProcessedRows: number;
    rejectedRows: number;
    errorRows: number;
  };
  rows: RowResult[];
};

function parseArgs(): CliArgs {
  const args: CliArgs = {
    workspaceId: null,
    file: null,
    mode: null,
    cycleId: null,
    importRunId: null,
    correctionRun: false,
    allowBundleParentCounts: false,
    outDir: "reports/inventory-master/import-runs",
  };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--workspace-id" && process.argv[i + 1]) args.workspaceId = process.argv[++i];
    else if (arg === "--file" && process.argv[i + 1]) args.file = process.argv[++i];
    else if (arg === "--dry-run") args.mode = "dry_run";
    else if (arg === "--apply") args.mode = "apply";
    else if (arg === "--cycle-id" && process.argv[i + 1]) args.cycleId = process.argv[++i];
    else if (arg === "--import-run-id" && process.argv[i + 1]) args.importRunId = process.argv[++i];
    else if (arg === "--correction-run") args.correctionRun = true;
    else if (arg === "--allow-bundle-parent-counts") args.allowBundleParentCounts = true;
    else if (arg === "--out-dir" && process.argv[i + 1]) args.outDir = process.argv[++i];
    else {
      throw new Error(
        `Unknown argument ${arg}. Usage: npx tsx scripts/import-inventory-master.ts --workspace-id <uuid> --file <xlsx> (--dry-run|--apply --cycle-id <id> --import-run-id <id>)`,
      );
    }
  }
  if (!args.workspaceId) throw new Error("--workspace-id is required");
  if (!args.file) throw new Error("--file is required");
  if (!args.mode) throw new Error("Choose exactly one mode: --dry-run or --apply");
  if (args.mode === "apply" && (!args.cycleId || !args.importRunId)) {
    throw new Error("--apply requires --cycle-id and --import-run-id");
  }
  return args;
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function parseCount(value: unknown): { ok: true; count: number } | { ok: false; reason: string } {
  if (value === null || value === undefined || value === "") return { ok: false, reason: "blank" };
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "") return { ok: false, reason: "blank" };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: "not_integer" };
  if (n < 0) return { ok: false, reason: "negative" };
  return { ok: true, count: n };
}

function fingerprintFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureNoChecksumConflict(args: CliArgs, checksum: string): void {
  if (args.mode !== "apply" || args.correctionRun || !args.cycleId) return;
  if (!existsSync(args.outDir)) return;
  const prefix = `baseline-import-${args.cycleId}-`;
  for (const name of readdirSync(args.outDir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const existing = JSON.parse(readFileSync(join(args.outDir, name), "utf8")) as ImportReport;
    if (existing.workbook.checksumSha256 && existing.workbook.checksumSha256 !== checksum) {
      throw new Error(
        `Cycle ${args.cycleId} already has report ${name} for a different workbook checksum. Re-run with --correction-run if this is intentional.`,
      );
    }
  }
}

async function main() {
  const args = parseArgs();
  const file = args.file as string;
  if (!existsSync(file)) throw new Error(`Workbook not found: ${file}`);

  const checksum = fingerprintFile(file);
  ensureNoChecksumConflict(args, checksum);

  const workbook = XLSX.readFile(file);
  const sheet = workbook.Sheets["Inventory Master"] ?? workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Workbook has no sheets");

  const rows = XLSX.utils.sheet_to_json<WorkbookRow>(sheet, { defval: "" });
  const countedRows = rows.filter((row) => {
    const parsed = parseCount(row["NEW COUNT"]);
    return parsed.ok || parsed.reason !== "blank";
  });
  const duplicateVariantIds = findDuplicates(
    countedRows.map((row) => asTrimmed(row["_variant_id"])).filter(Boolean),
  );
  const duplicateSkus = findDuplicates(countedRows.map((row) => asTrimmed(row.SKU)).filter(Boolean));

  const supabase = createServiceRoleClient();
  const variantIds = Array.from(
    new Set(countedRows.map((row) => asTrimmed(row["_variant_id"])).filter(Boolean)),
  );
  const skus = Array.from(new Set(countedRows.map((row) => asTrimmed(row.SKU)).filter(Boolean)));

  const variants = await loadVariants(supabase, args.workspaceId as string, variantIds, skus);
  const bundleParents = await loadBundleParents(supabase, args.workspaceId as string);
  for (const variant of variants.values()) {
    variant.is_bundle_parent = bundleParents.has(variant.id);
  }

  const rowResults: RowResult[] = [];
  for (const [index, row] of rows.entries()) {
    const rowNumber = Number(row["Row #"] || index + 2);
    const sku = asTrimmed(row.SKU) || null;
    const variantIdFromRow = asTrimmed(row["_variant_id"]) || null;
    const countResult = parseCount(row["NEW COUNT"]);
    if (!countResult.ok && countResult.reason === "blank") {
      rowResults.push(emptyResult(rowNumber, sku, variantIdFromRow, "blank_count", "NEW COUNT blank"));
      continue;
    }
    if (!countResult.ok) {
      rowResults.push(
        emptyResult(
          rowNumber,
          sku,
          variantIdFromRow,
          countResult.reason === "negative" ? "negative_count" : "invalid_count",
          countResult.reason,
        ),
      );
      continue;
    }
    if (variantIdFromRow && duplicateVariantIds.has(variantIdFromRow)) {
      rowResults.push(
        emptyResult(rowNumber, sku, variantIdFromRow, "duplicate_variant_id", "duplicate _variant_id"),
      );
      continue;
    }
    if (sku && duplicateSkus.has(sku)) {
      rowResults.push(emptyResult(rowNumber, sku, variantIdFromRow, "duplicate_sku", "duplicate SKU"));
      continue;
    }

    const match = matchVariant(variants, variantIdFromRow, sku, args.workspaceId as string);
    if (!match.ok) {
      rowResults.push(emptyResult(rowNumber, sku, variantIdFromRow, match.status, match.reason));
      continue;
    }

    const variant = match.variant;
    const delta = countResult.count - variant.available;
    let status: RowResult["status"] = "valid";
    let reason: string | undefined;
    if (variant.workspace_id !== args.workspaceId) {
      status = "wrong_workspace";
      reason = "variant belongs to another workspace";
    } else if (variant.product_status && ["archived", "deleted"].includes(variant.product_status)) {
      status = "archived_or_deleted";
      reason = `product status ${variant.product_status}`;
    } else if (variant.count_status === "count_in_progress") {
      status = "count_in_progress";
      reason = "count session in progress";
    } else if (variant.is_bundle_parent && !args.allowBundleParentCounts) {
      status = "bundle_parent_rejected";
      reason = "bundle parent counts are rejected by default; count component SKUs";
    }

    rowResults.push({
      rowNumber,
      sku: variant.sku,
      variantId: variant.id,
      orgId: variant.org_id,
      status,
      previousAvailable: variant.available,
      newCount: countResult.count,
      delta,
      reason,
      correlationId:
        args.cycleId && status === "valid"
          ? `baseline-count:${args.workspaceId}:${args.cycleId}:${variant.id}`
          : undefined,
    });
  }

  if (args.mode === "apply") {
    for (const row of rowResults) {
      if (isRejected(row.status)) {
        await upsertImportReview(supabase, args.workspaceId as string, args.cycleId as string, row);
        continue;
      }
      if (row.status !== "valid" || !row.sku || !row.correlationId || row.delta === null) continue;
      if (row.delta === 0) {
        row.status = "no_change";
        continue;
      }
      const result = await recordInventoryChange({
        workspaceId: args.workspaceId as string,
        sku: row.sku,
        delta: row.delta,
        source: "baseline_import",
        correlationId: row.correlationId,
        metadata: {
          action: "baseline_count_apply",
          row_number: row.rowNumber,
          prior_count: row.previousAvailable,
          new_count: row.newCount,
          delta: row.delta,
          workbook_filename: basename(file),
          workbook_checksum_sha256: checksum,
          cycle_id: args.cycleId,
          import_run_id: args.importRunId,
          import_mode: args.correctionRun ? "correction" : "baseline",
        },
        fanout: { suppress: true, reason: "baseline_import_bulk_apply" },
      });
      row.status = result.alreadyProcessed ? "already_processed" : result.success ? "applied" : "error";
      if (!result.success) row.reason = "recordInventoryChange failed";
    }
  }

  const report: ImportReport = {
    workspaceId: args.workspaceId as string,
    mode: args.mode,
    cycleId: args.cycleId,
    importRunId: args.importRunId,
    workbook: { path: file, filename: basename(file), checksumSha256: checksum },
    generatedAt: new Date().toISOString(),
    summary: summarize(rowResults),
    rows: rowResults,
  };

  mkdirSync(args.outDir, { recursive: true });
  const reportName = `baseline-import-${args.cycleId ?? "dry-run"}-${args.importRunId ?? Date.now()}.json`;
  const reportPath = join(args.outDir, reportName);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report.summary, reportPath }, null, 2));

  if (report.summary.errorRows > 0 || report.summary.rejectedRows > 0) {
    process.exitCode = args.mode === "apply" ? 1 : 0;
  }
}

function findDuplicates(values: string[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return dupes;
}

function emptyResult(
  rowNumber: number,
  sku: string | null,
  variantId: string | null,
  status: ValidationStatus,
  reason: string,
): RowResult {
  return {
    rowNumber,
    sku,
    variantId,
    orgId: null,
    status,
    previousAvailable: null,
    newCount: null,
    delta: null,
    reason,
  };
}

async function loadVariants(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  variantIds: string[],
  skus: string[],
): Promise<Map<string, VariantRecord>> {
  const byId = new Map<string, VariantRecord>();
  const batches = [
    ...variantIds.map((id) => ({ kind: "id" as const, value: id })),
    ...skus.map((sku) => ({ kind: "sku" as const, value: sku })),
  ];
  for (const batch of chunk(batches, 200)) {
    let query = supabase
      .from("warehouse_product_variants")
      .select(
        "id, workspace_id, sku, title, warehouse_inventory_levels(available, count_status), warehouse_products(org_id, status)",
      )
      .eq("workspace_id", workspaceId);
    const ids = batch.filter((b) => b.kind === "id").map((b) => b.value);
    const batchSkus = batch.filter((b) => b.kind === "sku").map((b) => b.value);
    if (ids.length > 0 && batchSkus.length > 0) {
      query = query.or(`id.in.(${ids.join(",")}),sku.in.(${batchSkus.join(",")})`);
    } else if (ids.length > 0) {
      query = query.in("id", ids);
    } else {
      query = query.in("sku", batchSkus);
    }
    const { data, error } = await query;
    if (error) throw new Error(`Variant lookup failed: ${error.message}`);
    for (const row of data ?? []) {
      const levels = Array.isArray(row.warehouse_inventory_levels)
        ? row.warehouse_inventory_levels[0]
        : row.warehouse_inventory_levels;
      const product = Array.isArray(row.warehouse_products)
        ? row.warehouse_products[0]
        : row.warehouse_products;
      byId.set(row.id, {
        id: row.id,
        workspace_id: row.workspace_id,
        sku: row.sku,
        title: row.title ?? null,
        count_status: levels?.count_status ?? null,
        available: levels?.available ?? 0,
        org_id: product?.org_id ?? null,
        product_status: product?.status ?? null,
        is_bundle_parent: false,
      });
    }
  }
  return byId;
}

async function loadBundleParents(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("bundle_components")
    .select("bundle_variant_id")
    .eq("workspace_id", workspaceId);
  if (error) return new Set();
  return new Set((data ?? []).map((row) => row.bundle_variant_id));
}

function matchVariant(
  variants: Map<string, VariantRecord>,
  variantId: string | null,
  sku: string | null,
  workspaceId: string,
):
  | { ok: true; variant: VariantRecord }
  | { ok: false; status: ValidationStatus; reason: string } {
  if (variantId) {
    const variant = variants.get(variantId);
    if (!variant) return { ok: false, status: "unknown_variant", reason: "unknown _variant_id" };
    return { ok: true, variant };
  }
  if (!sku) return { ok: false, status: "unknown_variant", reason: "missing SKU and _variant_id" };
  const matches = Array.from(variants.values()).filter(
    (variant) => variant.workspace_id === workspaceId && variant.sku === sku,
  );
  if (matches.length === 1) return { ok: true, variant: matches[0] };
  if (matches.length > 1) return { ok: false, status: "ambiguous_sku", reason: "multiple SKU matches" };
  return { ok: false, status: "unknown_variant", reason: "unknown SKU" };
}

function isRejected(status: RowResult["status"]): boolean {
  return (
    status !== "valid" &&
    status !== "blank_count" &&
    status !== "applied" &&
    status !== "already_processed" &&
    status !== "no_change"
  );
}

async function upsertImportReview(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  cycleId: string,
  row: RowResult,
): Promise<void> {
  const groupKey = `baseline-import:${cycleId}:${row.status}:${row.variantId ?? row.sku ?? row.rowNumber}`;
  const { error } = await supabase.from("warehouse_review_queue").upsert(
    {
      workspace_id: workspaceId,
      org_id: row.orgId,
      category: "baseline_import_reject",
      severity: row.status === "bundle_parent_rejected" ? "critical" : "high",
      title: `Baseline import rejected row ${row.rowNumber}`,
      description: `Baseline import rejected ${row.sku ?? row.variantId ?? "unknown row"}: ${row.reason ?? row.status}`,
      metadata: {
        row_number: row.rowNumber,
        sku: row.sku,
        variant_id: row.variantId,
        status: row.status,
        reason: row.reason,
        cycle_id: cycleId,
        source: "baseline_import",
      },
      group_key: groupKey,
    },
    { onConflict: "group_key" },
  );
  if (error) {
    console.error(`[import-inventory-master] failed to upsert review item: ${error.message}`);
  }
}

function summarize(rows: RowResult[]): ImportReport["summary"] {
  return {
    rowsRead: rows.length,
    validRows: rows.filter((row) => row.status === "valid").length,
    appliedRows: rows.filter((row) => row.status === "applied").length,
    noChangeRows: rows.filter((row) => row.status === "no_change").length,
    alreadyProcessedRows: rows.filter((row) => row.status === "already_processed").length,
    rejectedRows: rows.filter((row) => isRejected(row.status)).length,
    errorRows: rows.filter((row) => row.status === "error").length,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
