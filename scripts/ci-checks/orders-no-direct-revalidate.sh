#!/usr/bin/env bash
#
# Order Pages Transition Phase 0 — order-surface invalidation guard.
#
# Forbids inline `revalidatePath('/admin/orders` calls anywhere outside
# the centralized `src/lib/server/invalidate-order-surfaces.ts` helper
# and the route-mode flip Server Action.
#
# The transition has multiple new surfaces (Direct Orders, ShipStation
# Mirror, Diagnostics, Holds, per-order Detail). When 12 different call
# sites each invalidate a partial subset, the cache map silently rots:
# fix the bug in three places, miss seven, and watch staff hit stale
# rows for a release cycle. Centralizing the invalidator is the only
# way to keep the CACHE_ARCHITECTURE.md addendum trustworthy.
#
# Allowlisted call sites (intentional):
#   1. src/lib/server/invalidate-order-surfaces.ts — the helper itself.
#   2. src/actions/order-route-mode.ts — needs a belt-and-braces flush
#      after a route-mode flip (incident scenario, must be immediate).
#
# What's banned:
#   Any `revalidatePath("/admin/orders` or `revalidatePath('/admin/orders`
#   call (with or without a path suffix) outside the allowlist.
set -euo pipefail
cd "$(dirname "$0")/../.."

ALLOWLIST=(
  "src/lib/server/invalidate-order-surfaces.ts"
  "src/actions/order-route-mode.ts"
  "scripts/ci-checks/orders-no-direct-revalidate.sh"
)

VIOLATIONS=()
while IFS= read -r file; do
  skip=false
  for allowed in "${ALLOWLIST[@]}"; do
    if [ "$file" = "$allowed" ]; then
      skip=true
      break
    fi
  done
  if [ "$skip" = false ]; then
    VIOLATIONS+=("$file")
  fi
done < <(grep -rlE --include='*.ts' --include='*.tsx' \
  "revalidatePath\(['\"]\/admin\/orders" src/ 2>/dev/null || true)

if [ "${#VIOLATIONS[@]}" -gt 0 ]; then
  echo "ERROR: direct revalidatePath('/admin/orders...') call outside the centralized helper."
  echo ""
  echo "Affected files:"
  for v in "${VIOLATIONS[@]}"; do
    echo "  $v"
    grep -nE "revalidatePath\(['\"]\/admin\/orders" "$v" | sed 's/^/    /'
  done
  echo ""
  echo "Replace the inline call with:"
  echo "  import { invalidateOrderSurfaces } from \"@/lib/server/invalidate-order-surfaces\";"
  echo "  await invalidateOrderSurfaces({ workspaceId, kinds: [\"direct.list\", ...] });"
  echo ""
  echo "See: src/lib/server/invalidate-order-surfaces.ts and the Cache Contract Addendum"
  echo "in docs/system_map/CACHE_ARCHITECTURE.md."
  exit 1
fi

echo "OK: revalidatePath('/admin/orders...') calls only appear in the centralized helper."
