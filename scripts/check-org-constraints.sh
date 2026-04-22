#!/usr/bin/env bash
# P9 (T-2) preflight — org-constraint coverage for merge_organizations_txn.
#
# Diffs every table in the live database that participates in org ownership
# (either holds an `org_id` column OR carries an FK pointing at
# `organizations(id)`) against the canonical `v_tables` array compiled into
# `merge_organizations_txn` (supabase/migrations/20260423000001_org_merge_rpc.sql).
#
# Why: the merge RPC's final step is `delete from organizations where id = ...`.
# If a new org_id-bearing table is added without registering it in `v_tables`,
# the orphan FK trips a `foreign_key_violation` and the entire merge aborts
# (raising `merge_delete_failed`). This script catches the gap BEFORE the
# operator runs the merge — same contract as `scripts/check-fanout-gate.sh`
# and `scripts/check-webhook-runtime.sh`.
#
# Usage:
#   DATABASE_URL=postgres://... bash scripts/check-org-constraints.sh
#
# Exits 0 when the live DB ⊆ v_tables (unknown live tables → fail; missing
# from live but listed in v_tables → warn-only, since the RPC is forgiving).
# Exits 1 on any stray live table or when DATABASE_URL/psql is unavailable.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

MIGRATION_FILE="supabase/migrations/20260423000001_org_merge_rpc.sql"

if [[ ! -f "$MIGRATION_FILE" ]]; then
  printf "FAIL — migration file not found: %s\n" "$MIGRATION_FILE" >&2
  exit 1
fi

# ─── 1. Extract v_tables from the merge_organizations_txn body ────────────────
# Each merge function declares its own v_tables array; the canonical mutation
# list lives inside merge_organizations_txn (the second occurrence, after
# preview_merge_organizations). Strip SQL comments + quotes + whitespace so we
# get a clean newline-delimited table list.
extract_v_tables() {
  awk '
    /^create or replace function merge_organizations_txn/ { in_fn = 1 }
    in_fn && /v_tables[[:space:]]*text\[\][[:space:]]*:=[[:space:]]*array\[/ {
      capturing = 1
      next
    }
    capturing && /\];/ { capturing = 0; in_fn = 0; exit }
    capturing {
      gsub(/--.*$/, "")
      gsub(/[[:space:]]/, "")
      gsub(/,/, "\n")
      gsub(/'\''/, "")
      print
    }
  ' "$MIGRATION_FILE" | grep -v '^$' | sort -u
}

EXPECTED_TABLES_FILE="$(mktemp)"
LIVE_TABLES_FILE="$(mktemp)"
STRAY_FILE="$(mktemp)"
PHANTOM_FILE="$(mktemp)"
trap 'rm -f "$EXPECTED_TABLES_FILE" "$LIVE_TABLES_FILE" "$STRAY_FILE" "$PHANTOM_FILE" 2>/dev/null || true' EXIT

extract_v_tables > "$EXPECTED_TABLES_FILE"

EXPECTED_COUNT=$(wc -l < "$EXPECTED_TABLES_FILE" | tr -d '[:space:]')
if [[ "$EXPECTED_COUNT" -eq 0 ]]; then
  printf "FAIL — could not extract v_tables from %s (parser regression?)\n" "$MIGRATION_FILE" >&2
  exit 1
fi

printf "==> Loaded %d expected tables from merge_organizations_txn.v_tables\n" "$EXPECTED_COUNT"

# ─── 2. Database probe ────────────────────────────────────────────────────────
if ! command -v psql >/dev/null 2>&1; then
  printf "FAIL — psql not on PATH; install Postgres client or run via supabase CLI\n" >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  printf "FAIL — DATABASE_URL not set; export it (or run via Supabase pooled URL) and retry\n" >&2
  exit 1
fi

# Two sources of truth, UNIONed:
#   (a) every table in the public schema with a column named org_id
#   (b) every table whose FK points at organizations(id)
# Both filter to the public schema so internal Supabase tables (auth.*, etc.)
# don't appear as false positives.
psql "$DATABASE_URL" -At -X -v ON_ERROR_STOP=1 <<'SQL' > "$LIVE_TABLES_FILE"
with org_id_tables as (
  select c.table_name
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.column_name = 'org_id'
),
fk_tables as (
  select tc.table_name
  from information_schema.table_constraints tc
  join information_schema.constraint_column_usage ccu
    on ccu.constraint_name = tc.constraint_name
   and ccu.table_schema    = tc.table_schema
  where tc.constraint_type = 'FOREIGN KEY'
    and tc.table_schema    = 'public'
    and ccu.table_schema   = 'public'
    and ccu.table_name     = 'organizations'
    and ccu.column_name    = 'id'
)
select table_name from org_id_tables
union
select table_name from fk_tables
order by 1;
SQL

LIVE_COUNT=$(wc -l < "$LIVE_TABLES_FILE" | tr -d '[:space:]')
printf "==> Probed %d live tables that touch organizations.id\n\n" "$LIVE_COUNT"

# ─── 3. Diff ──────────────────────────────────────────────────────────────────
# Strays: live tables that are NOT registered in v_tables → HARD FAIL
#   (would cause merge_delete_failed at runtime).
# Phantoms: registered tables that no longer exist in the DB → WARN only
#   (loop is a no-op for those rows; safe but noisy).

# Excluded from the strays list:
#   - organizations               (it IS the target table; merge deletes it last)
#   - organization_aliases        (already in v_tables — guard against rename)
#   - schema-managed scaffolding  (none today, kept here as the future allowlist)
EXCLUDE_FROM_STRAYS_REGEX='^organizations$'

comm -23 \
  <(grep -Ev "$EXCLUDE_FROM_STRAYS_REGEX" "$LIVE_TABLES_FILE" | sort -u) \
  "$EXPECTED_TABLES_FILE" \
  > "$STRAY_FILE"

comm -13 \
  <(grep -Ev "$EXCLUDE_FROM_STRAYS_REGEX" "$LIVE_TABLES_FILE" | sort -u) \
  "$EXPECTED_TABLES_FILE" \
  > "$PHANTOM_FILE"

STRAY_COUNT=$(wc -l < "$STRAY_FILE" | tr -d '[:space:]')
PHANTOM_COUNT=$(wc -l < "$PHANTOM_FILE" | tr -d '[:space:]')

EXIT_CODE=0

if [[ "$STRAY_COUNT" -gt 0 ]]; then
  printf "FAIL — %d table(s) hold org_id or FK organizations.id but are MISSING from v_tables:\n" "$STRAY_COUNT"
  while IFS= read -r tbl; do
    printf "       - %s\n" "$tbl"
  done < "$STRAY_FILE"
  printf "       Add the names above to the v_tables array in:\n"
  printf "         %s\n" "$MIGRATION_FILE"
  printf "       Until then merge_organizations_txn will trip merge_delete_failed.\n\n"
  EXIT_CODE=1
fi

if [[ "$PHANTOM_COUNT" -gt 0 ]]; then
  printf "WARN — %d table(s) listed in v_tables no longer exist in the live DB:\n" "$PHANTOM_COUNT"
  while IFS= read -r tbl; do
    printf "       - %s\n" "$tbl"
  done < "$PHANTOM_FILE"
  printf "       The merge loop is a no-op for these rows (safe), but the list is\n"
  printf "       drifting — drop the dropped names from v_tables to keep it tight.\n\n"
fi

if [[ "$EXIT_CODE" -eq 0 && "$PHANTOM_COUNT" -eq 0 ]]; then
  printf "PASS  — every org-aware table is registered in merge_organizations_txn.v_tables\n"
elif [[ "$EXIT_CODE" -eq 0 ]]; then
  printf "PASS  — no strays (warnings above are non-blocking)\n"
fi

exit "$EXIT_CODE"
