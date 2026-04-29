#!/usr/bin/env bash
#
# Order Pages Transition Phase 4a — preorder predicate drift guard.
#
# The canonical preorder-pending predicate lives in two files:
#   1. supabase/migrations/20260429000003_preorder_pending_view.sql
#      (the SQL VIEW preorder_pending_orders)
#   2. src/lib/shared/order-preorder.ts (the pure TS helper
#      `deriveOrderPreorderState` used by Mirror cockpit + ingest)
#
# This guard sanity-checks that:
#   (a) the SQL view body still references BOTH `warehouse_orders` AND
#       `shipstation_orders`. A drift writer that drops one source
#       silently breaks parity for that surface.
#   (b) the TS helper still references both surfaces' canonical state
#       vocabulary (`is_preorder` for Direct, `preorder_state` for
#       Mirror). A drift writer that renames either column without
#       updating the view will trip the build.
#
# The guard is intentionally cheap (grep-level). The full predicate
# parity test lives in `tests/unit/lib/shared/order-preorder.test.ts`
# (Phase 4a follow-up); this CI guard is the first line of defense.
set -euo pipefail
cd "$(dirname "$0")/../.."

VIEW_SQL="supabase/migrations/20260429000003_preorder_pending_view.sql"
HELPER_TS="src/lib/shared/order-preorder.ts"

if [ ! -f "$VIEW_SQL" ]; then
  echo "ERROR: missing canonical preorder view migration: $VIEW_SQL"
  exit 1
fi
if [ ! -f "$HELPER_TS" ]; then
  echo "ERROR: missing canonical preorder TS helper: $HELPER_TS"
  exit 1
fi

if ! grep -q 'warehouse_orders' "$VIEW_SQL"; then
  echo "ERROR: $VIEW_SQL no longer references warehouse_orders. Direct surface is missing."
  exit 1
fi
if ! grep -q 'shipstation_orders' "$VIEW_SQL"; then
  echo "ERROR: $VIEW_SQL no longer references shipstation_orders. Mirror surface is missing."
  exit 1
fi

if ! grep -q 'is_preorder' "$HELPER_TS"; then
  echo "ERROR: $HELPER_TS no longer references is_preorder. Direct vocabulary missing."
  exit 1
fi
if ! grep -q "preorder_state" "$VIEW_SQL"; then
  echo "ERROR: $VIEW_SQL no longer references preorder_state. Mirror vocabulary missing."
  exit 1
fi

echo "OK: preorder predicate references both warehouse_orders and shipstation_orders."
