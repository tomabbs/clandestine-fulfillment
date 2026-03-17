#!/usr/bin/env bash
# CI guard: no direct warehouse_inventory_levels access outside the canonical write path.
# See CLAUDE.md rule 42.

set -euo pipefail

ALLOWED_FILES=(
  "src/lib/server/record-inventory-change.ts"
  "tests/"
  "supabase/migrations/"
  "scripts/ci-inventory-guard.sh"
  "CLAUDE.md"
)

# Build grep exclude pattern
EXCLUDE_ARGS=()
for f in "${ALLOWED_FILES[@]}"; do
  EXCLUDE_ARGS+=(--glob "!${f}")
done

# Search for direct table access
VIOLATIONS=$(grep -r \
  --glob '*.ts' --glob '*.tsx' \
  "${EXCLUDE_ARGS[@]}" \
  -e "warehouse_inventory_levels" \
  -e "inv:" \
  src/ 2>/dev/null || true)

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Direct warehouse_inventory_levels or Redis inv: access found outside canonical write path."
  echo "All inventory writes must go through recordInventoryChange(). See CLAUDE.md rule 42."
  echo ""
  echo "$VIOLATIONS"
  exit 1
fi

echo "OK: No direct inventory access violations found."
