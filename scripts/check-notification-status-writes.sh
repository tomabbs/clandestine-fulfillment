#!/usr/bin/env bash
# CI guard: no direct .update({ status }) on notification_sends or
# warehouse_shipments.easypost_tracker_status outside the canonical wrapper
# (src/lib/server/notification-status.ts).
#
# Slice 2 of the tracking-notification-hardening plan introduces sticky
# terminal state machines via two PL/pgSQL RPCs:
#   - update_notification_status_safe()
#   - update_shipment_tracking_status_safe()
# Every status write MUST go through the wrapper module so the state machine
# guards (delivered cannot regress to bounced; bounced cannot be overwritten
# by delivered; etc.) are honoured. Bypassing the wrapper to write
# notification_sends.status directly = a state-machine-bypassing bug.
#
# This guard mirrors the pattern of scripts/ci-inventory-guard.sh which
# enforces CLAUDE.md rule 42 for inventory writes.

set -euo pipefail

# Hard-fail if ripgrep isn't available — otherwise the guard becomes a
# silent no-op and a bypass slips through CI. Every CI matrix that runs
# this script (pnpm verify:cloud, GH Actions) ships with rg.
if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: ripgrep (\`rg\`) is required by scripts/check-notification-status-writes.sh"
  echo "Install via: brew install ripgrep   |   apt-get install ripgrep"
  exit 2
fi

# Files allowed to write notification_sends.status / easypost_tracker_status
# directly. Anything else triggers the guard.
ALLOWED_FILES=(
  "src/lib/server/notification-status.ts"
  "src/lib/server/notification-sends.ts"
  "tests/"
  "supabase/migrations/"
  "scripts/check-notification-status-writes.sh"
  "CLAUDE.md"
  "docs/"
)

EXCLUDE_ARGS=()
for f in "${ALLOWED_FILES[@]}"; do
  EXCLUDE_ARGS+=(--glob "!${f}")
done

# Define a `ts` type that covers .ts and .tsx so the script doesn't depend on
# ripgrep's built-in tsx alias (older rg builds don't ship one).
TYPE_ARGS=(--type-add 'ts:*.ts,*.tsx,*.mts,*.cts')

# Pattern 1: PostgREST .update({ status: ... }) on notification_sends.
# We can't fully parse JS to know which table the .update() targets, so we
# look for the table identifier within ~5 lines of an update() call. Two
# heuristics that catch the real-world drift case:
#   .from("notification_sends") ... .update(... status ...)
#   .update(... status ...) ... .from("notification_sends")
# Plus any literal that mentions easypost_tracker_status in an update
# context.
NOTIFICATION_VIOLATIONS=$(rg \
  "${TYPE_ARGS[@]}" --type ts \
  "${EXCLUDE_ARGS[@]}" \
  -U --multiline-dotall \
  -e 'from\("notification_sends"\)[\s\S]{0,400}\.update\([^)]*status' \
  -e '\.update\([^)]*status[\s\S]{0,400}from\("notification_sends"\)' \
  src/ 2>/dev/null || true)

# Pattern 2: easypost_tracker_status appearing inside a .update() block on
# warehouse_shipments. This is rare (the column doesn't exist in the live
# schema yet — Slice 3 adds it) but the guard is defense-in-depth so the
# moment Slice 3 lands, no caller can bypass update_shipment_tracking_status_safe.
TRACKING_VIOLATIONS=$(rg \
  "${TYPE_ARGS[@]}" --type ts \
  "${EXCLUDE_ARGS[@]}" \
  -e 'easypost_tracker_status' \
  src/ 2>/dev/null \
  | grep -v "^[^:]*:[[:space:]]*//" \
  | grep -v "^[^:]*:[[:space:]]*\\*" \
  || true)

# Pattern 3: SQL string literals doing UPDATE notification_sends SET status
# (e.g. via supabase.rpc raw SQL) — also forbidden outside the wrapper.
SQL_VIOLATIONS=$(rg \
  "${TYPE_ARGS[@]}" --type ts \
  "${EXCLUDE_ARGS[@]}" \
  -i \
  -e 'UPDATE\s+notification_sends\s+SET\s+status' \
  src/ 2>/dev/null || true)

ANY_VIOLATIONS=""
if [ -n "$NOTIFICATION_VIOLATIONS" ]; then
  ANY_VIOLATIONS="yes"
  echo "ERROR: Direct notification_sends.status write found outside the canonical wrapper."
  echo "All status writes must go through updateNotificationStatusSafe()"
  echo "in src/lib/server/notification-status.ts so the sticky-terminal state"
  echo "machine RPCs (update_notification_status_safe) are honoured."
  echo ""
  echo "$NOTIFICATION_VIOLATIONS"
  echo ""
fi

if [ -n "$TRACKING_VIOLATIONS" ]; then
  # Distinguish "writes" from "reads" — only flag .update() / SET / assignment
  # contexts. Allow SELECT projections and TS interface declarations.
  WRITE_TRACKING_VIOLATIONS=$(echo "$TRACKING_VIOLATIONS" \
    | rg -e '\.update\(' -e 'SET[[:space:]]+easypost_tracker_status' -e '=\s*' \
    || true)
  if [ -n "$WRITE_TRACKING_VIOLATIONS" ]; then
    ANY_VIOLATIONS="yes"
    echo "ERROR: Direct easypost_tracker_status write found outside the canonical wrapper."
    echo "All tracker status writes must go through updateShipmentTrackingStatusSafe()"
    echo "in src/lib/server/notification-status.ts."
    echo ""
    echo "$WRITE_TRACKING_VIOLATIONS"
    echo ""
  fi
fi

if [ -n "$SQL_VIOLATIONS" ]; then
  ANY_VIOLATIONS="yes"
  echo "ERROR: Raw SQL UPDATE notification_sends SET status found outside the canonical wrapper."
  echo ""
  echo "$SQL_VIOLATIONS"
  echo ""
fi

if [ -n "$ANY_VIOLATIONS" ]; then
  echo "Wrapper module: src/lib/server/notification-status.ts"
  echo "RPC contracts:"
  echo "  - update_notification_status_safe(p_notification_id, p_new_status, ...)"
  echo "  - update_shipment_tracking_status_safe(p_shipment_id, p_new_status, ...)"
  exit 1
fi

echo "OK: No direct notification status / tracker status writes found outside the wrapper."
