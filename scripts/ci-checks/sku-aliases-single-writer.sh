#!/usr/bin/env bash
# SKU-AUTO-2 guard: aliases produced by the autonomous matcher are written
# ONLY via the `persist_sku_match` RPC (directly or via
# `promote_identity_match_to_alias` → `persist_sku_match`). Both RPCs call
# INSERT/UPDATE on `client_store_sku_mappings` from PL/pgSQL; from the
# application's perspective, neither path appears as a direct
# `.from("client_store_sku_mappings").insert/upsert/update/delete` call.
#
# The one legacy exception is the operator-triggered
# `autoDiscoverSkus()` in `src/actions/store-connections.ts`, which
# pre-existed the autonomous matcher and seeds exact-SKU mappings on
# connection setup. It is explicitly whitelisted below. Any NEW direct
# writer to `client_store_sku_mappings` — from a Server Action, Trigger
# task, or shared lib — fails CI and must either (a) route through
# `persist_sku_match` or (b) be added to the whitelist in this script
# AND explained in the SKU-AUTO-2 row in
# `docs/RELEASE_GATE_CRITERIA.md`.
#
# Plan ref: autonomous_sku_matching_da557209.plan.md
#           §"Alias write path" → "persist_sku_match invariant"
#
# Release gate: SKU-AUTO-2 in docs/RELEASE_GATE_CRITERIA.md §C.5.

set -uo pipefail

cd "$(dirname "$0")/../.."

TABLE="client_store_sku_mappings"

# Whitelist of files allowed to call `.from("$TABLE").<mutation>` directly.
ALLOWED_FILES=(
  "src/actions/store-connections.ts"
)

# Assert every whitelisted file still exists — prevents silent drift
# where the writer is refactored away but the whitelist stays stale.
for allowed in "${ALLOWED_FILES[@]}"; do
  if [ ! -f "$allowed" ]; then
    echo "ERROR: whitelisted file not found: $allowed"
    echo ""
    echo "If the writer has been refactored through persist_sku_match,"
    echo "remove this entry from ALLOWED_FILES and retire the exception"
    echo "note in the SKU-AUTO-2 row in docs/RELEASE_GATE_CRITERIA.md."
    exit 1
  fi
done

# Single-line regex matching `.from("client_store_sku_mappings").<verb>(`
# as it appears in the codebase. The Supabase JS client builder always
# chains the mutation verb immediately after `.from(...)` even when
# subsequent args wrap onto following lines, so a single-line `-E` grep
# is sufficient.
PATTERN='\.from\("'"$TABLE"'"\)\.(insert|upsert|update|delete)\('

# Collect every violation across src/**/*.ts, line-numbered.
ALL_HITS=$(grep -rEn --include='*.ts' "$PATTERN" src/ 2>/dev/null || true)

VIOLATIONS=()
if [ -n "$ALL_HITS" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    FILE="${line%%:*}"
    ALLOWED=0
    for allowed in "${ALLOWED_FILES[@]}"; do
      if [ "$FILE" = "$allowed" ]; then
        ALLOWED=1
        break
      fi
    done
    if [ "$ALLOWED" -eq 0 ]; then
      VIOLATIONS+=("$line")
    fi
  done <<< "$ALL_HITS"
fi

if [ "${#VIOLATIONS[@]}" -eq 0 ]; then
  echo "OK: All direct writers to $TABLE are on the whitelist:"
  for allowed in "${ALLOWED_FILES[@]}"; do
    echo "  - $allowed"
  done
  exit 0
fi

echo "ERROR: Unauthorized direct writes to $TABLE found."
echo ""
echo "Aliases produced by the autonomous matcher must route through"
echo "persist_sku_match() via supabase.rpc(...), NOT direct"
echo ".from(\"$TABLE\").insert/upsert/update/delete."
echo ""
echo "Violations (file:line: snippet):"
printf '  %s\n' "${VIOLATIONS[@]}"
echo ""
echo "If this is a legitimate new legacy-seed path, add it to"
echo "ALLOWED_FILES in scripts/ci-checks/sku-aliases-single-writer.sh"
echo "AND update the SKU-AUTO-2 row in docs/RELEASE_GATE_CRITERIA.md to"
echo "document the new whitelist entry."
exit 1
