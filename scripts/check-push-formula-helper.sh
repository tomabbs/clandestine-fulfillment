#!/usr/bin/env bash
# Phase 1 §9.2 D8 / N-13 / X-7 — CI guard: every inventory push site must
# source the push formula from `src/lib/server/effective-sellable.ts`.
#
# The formula `MAX(0, available - committed - safety_stock[channel])` is the
# single source of truth for "what value do we PUSH to a sales channel". The
# X-7 dual-edit hazard is real: if a focused per-SKU push computes one
# number and the 5-min cron computes another, Bandcamp / Shopify inventory
# will oscillate between two values per SKU per drop.
#
# This script greps for inline reconstructions of the formula anywhere in
# `src/` outside the helper file and its companion test, and fails CI if
# any are found. The pattern intentionally matches the most common shapes
# we have seen historically: `Math.max(0, X - Y)` where X is some
# `available` variable and Y is some `safety` / `safetyStock` /
# `workspaceSafety` variable. It does NOT try to be exhaustive — the
# helper itself defines `PUSH_FORMULA_GREP_PATTERN` (a JS regex) for unit
# tests; this script is a coarser belt-and-suspenders check at the source
# level so a refactor that breaks the unit test still trips CI.
#
# Allow-list:
#   - The helper file itself (defines the formula).
#   - The helper's unit test (asserts the formula).
#   - This file (the comments above contain a copy of the formula).
#
# Wire into release-gate.sh as Section A's "push-formula source-of-truth guard".

set -euo pipefail

cd "$(dirname "$0")/.."

ALLOWLIST=(
  "src/lib/server/effective-sellable.ts"
  "tests/unit/lib/server/effective-sellable.test.ts"
  "scripts/check-push-formula-helper.sh"
  # Display-only "Listed As" cells on inventory pages. These compute a
  # generic "available - workspace default safety" view for the operator
  # — NOT a per-channel push value. The push paths use the helper; these
  # display cells will migrate to the helper's per-channel readout in
  # Phase 5 when the per-channel safety stock UI lands.
  "src/app/admin/inventory/page.tsx"
  "src/app/portal/inventory/page.tsx"
)

# Pattern matches the inline push-formula shape:
#   Math.max(0, <available_var> - <safety_var>)
# where the second operand contains 'afety' (case-sensitive — catches
# Safety / safety / SafetyStock / safety_stock). Using `afety` instead of
# the full word avoids depending on word boundaries across different
# variable naming styles.
INLINE_FORMULA_REGEX='Math\.max\(\s*0\s*,[^)]*[Aa]vailable[^)]*-[^)]*afety'

VIOLATIONS=()

while IFS= read -r file; do
  skip=0
  for allowed in "${ALLOWLIST[@]}"; do
    if [ "$file" = "$allowed" ]; then
      skip=1
      break
    fi
  done
  [ "$skip" -eq 1 ] && continue
  VIOLATIONS+=("$file")
done < <(grep -rlE --include='*.ts' --include='*.tsx' "$INLINE_FORMULA_REGEX" src/ tests/ 2>/dev/null || true)

if [ "${#VIOLATIONS[@]}" -gt 0 ]; then
  echo "ERROR: Inline push-formula construction detected outside the helper."
  echo "Plan ref: §9.2 D8 / N-13 / X-7 dual-edit invariant."
  echo ""
  echo "Files with inline 'Math.max(0, *available - *safety*)' shapes:"
  printf '  %s\n' "${VIOLATIONS[@]}"
  echo ""
  echo "Replace inline construction with one of:"
  echo "  - computeEffectiveSellable()  for I/O-bound paths (Server Actions, focused tasks)"
  echo "  - evaluateEffectiveSellable() for pre-loaded snapshots (cron sweeps)"
  echo "Both live in src/lib/server/effective-sellable.ts."
  exit 1
fi

echo "OK: All push-formula sites import from src/lib/server/effective-sellable.ts."
