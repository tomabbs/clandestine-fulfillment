/**
 * Bandcamp inbound forwarding address audit (Phase 2 §9.3 D5).
 *
 * Pre-activation gate for the per-connection email routing introduced by
 * `bandcamp-sale-poll-per-connection` and `dispatchBandcampOrderPoll()`.
 * Every active `bandcamp_connections` row must have a valid, unique
 * `inbound_forwarding_address` before we can claim the per-connection path
 * is the primary route — otherwise the router silently falls back to the
 * global N-way poll for unconfigured rows and the operator never notices.
 *
 * Read-only. Side-effects: writes a JSON report to
 * `reports/bandcamp-inbound-forwarding-audit-{ISOts}.json` (so the report
 * can be cited from a release-gate doc) and prints a human-readable
 * summary to stdout.
 *
 * Exit codes:
 *   0  — every active row has a valid, unique address (gate passes)
 *   1  — at least one active row is missing the address, or duplicates
 *         exist, or addresses fail the email-shape regex (gate blocks)
 *   2  — internal error reading from Supabase
 *
 * Usage:
 *   npx tsx scripts/_bandcamp-inbound-forwarding-audit.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// Lightly permissive RFC-ish email check — the column also stores aliases
// like `orders+truepanther@clandestinedistro.com` so we accept the `+` tag.
const EMAIL_REGEX = /^[\w.!#$%&'*+\-/=?^_`{|}~]+@[\w.-]+\.[A-Za-z]{2,}$/;

interface ConnectionRow {
  id: string;
  workspace_id: string;
  band_id: number | string;
  band_name: string | null;
  is_active: boolean | null;
  inbound_forwarding_address: string | null;
  created_at: string | null;
}

interface AuditReport {
  generatedAt: string;
  totals: {
    active: number;
    inactive: number;
    activeWithAddress: number;
    activeMissingAddress: number;
    activeInvalidAddress: number;
    duplicateAddressGroups: number;
  };
  activeMissingAddress: ConnectionRow[];
  activeInvalidAddress: Array<ConnectionRow & { reason: string }>;
  duplicates: Array<{ address: string; rows: ConnectionRow[] }>;
  passes: boolean;
}

async function main(): Promise<void> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("bandcamp_connections")
    .select(
      "id, workspace_id, band_id, band_name, is_active, inbound_forwarding_address, created_at",
    )
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[bandcamp-inbound-audit] failed to read bandcamp_connections:", error);
    process.exit(2);
  }

  const rows: ConnectionRow[] = data ?? [];

  const active = rows.filter((r) => r.is_active === true);
  const inactive = rows.filter((r) => r.is_active !== true);

  const activeMissingAddress = active.filter(
    (r) => !r.inbound_forwarding_address || !r.inbound_forwarding_address.trim(),
  );

  const activeInvalidAddress: Array<ConnectionRow & { reason: string }> = [];
  for (const r of active) {
    const raw = r.inbound_forwarding_address;
    if (!raw || !raw.trim()) continue;
    const trimmed = raw.trim();
    if (trimmed !== raw) {
      activeInvalidAddress.push({ ...r, reason: "leading_or_trailing_whitespace" });
      continue;
    }
    if (trimmed !== trimmed.toLowerCase()) {
      activeInvalidAddress.push({ ...r, reason: "not_lowercase" });
      continue;
    }
    if (!EMAIL_REGEX.test(trimmed)) {
      activeInvalidAddress.push({ ...r, reason: "email_regex_mismatch" });
    }
  }

  // Duplicate detection across ALL rows (active + inactive) — the partial
  // unique index from migration 20260427000002 only covers NOT NULL rows,
  // so case-mismatched dupes (e.g. mixed-case stored values from a prior
  // hand-edit) might slip through. Detect them here regardless.
  const byAddress = new Map<string, ConnectionRow[]>();
  for (const r of rows) {
    const addr = r.inbound_forwarding_address?.trim().toLowerCase();
    if (!addr) continue;
    const list = byAddress.get(addr) ?? [];
    list.push(r);
    byAddress.set(addr, list);
  }
  const duplicates = Array.from(byAddress.entries())
    .filter(([, list]) => list.length > 1)
    .map(([address, rows]) => ({ address, rows }));

  const passes =
    activeMissingAddress.length === 0 &&
    activeInvalidAddress.length === 0 &&
    duplicates.length === 0;

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    totals: {
      active: active.length,
      inactive: inactive.length,
      activeWithAddress: active.length - activeMissingAddress.length,
      activeMissingAddress: activeMissingAddress.length,
      activeInvalidAddress: activeInvalidAddress.length,
      duplicateAddressGroups: duplicates.length,
    },
    activeMissingAddress,
    activeInvalidAddress,
    duplicates,
    passes,
  };

  // Console summary
  console.log("=== Bandcamp inbound-forwarding audit ===");
  console.log(`Generated: ${report.generatedAt}`);
  console.log("\nTotals:");
  for (const [k, v] of Object.entries(report.totals)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  if (activeMissingAddress.length > 0) {
    console.log(`\nActive rows MISSING inbound_forwarding_address (${activeMissingAddress.length}):`);
    for (const r of activeMissingAddress) {
      console.log(
        `  - id=${r.id}  workspace=${r.workspace_id}  band_id=${r.band_id}  band_name=${
          r.band_name ?? "(null)"
        }`,
      );
    }
  }
  if (activeInvalidAddress.length > 0) {
    console.log(`\nActive rows with INVALID address (${activeInvalidAddress.length}):`);
    for (const r of activeInvalidAddress) {
      console.log(
        `  - id=${r.id}  band_id=${r.band_id}  reason=${r.reason}  value=${
          r.inbound_forwarding_address ?? "(null)"
        }`,
      );
    }
  }
  if (duplicates.length > 0) {
    console.log(`\nDUPLICATE addresses (${duplicates.length} groups):`);
    for (const dup of duplicates) {
      console.log(`  - ${dup.address}`);
      for (const r of dup.rows) {
        console.log(
          `      id=${r.id}  workspace=${r.workspace_id}  band_id=${r.band_id}  active=${
            r.is_active ?? false
          }`,
        );
      }
    }
  }

  // JSON report
  const reportsDir = path.resolve(process.cwd(), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(reportsDir, `bandcamp-inbound-forwarding-audit-${ts}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull JSON report → ${outPath}`);

  console.log(passes ? "\nGATE: PASS — per-connection routing is safe to flip on." : "\nGATE: FAIL — per-connection routing will silently fall back for the offending rows.");

  process.exit(passes ? 0 : 1);
}

main().catch((err) => {
  console.error("[bandcamp-inbound-audit] unexpected error:", err);
  process.exit(2);
});
