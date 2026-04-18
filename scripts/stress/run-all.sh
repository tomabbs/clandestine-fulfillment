#!/usr/bin/env bash
#
# Phase 5 (finish-line plan v4) — stress harness orchestrator.
#
# Runs every script in scripts/stress/*.ts in series under the same workspace
# id (passed via env var WORKSPACE_ID or first positional arg). Each script
# writes its own report under reports/stress/${stress_run_id}.json; this
# orchestrator simply chains them and exits non-zero on the first failure.
#
# Usage:
#   WORKSPACE_ID=<uuid> bash scripts/stress/run-all.sh [--dry-run|--apply]
#   bash scripts/stress/run-all.sh <uuid> --dry-run

set -uo pipefail

WORKSPACE_ID="${WORKSPACE_ID:-}"
MODE_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE_FLAG="--dry-run" ;;
    --apply)   MODE_FLAG="--apply" ;;
    *)
      if [ -z "$WORKSPACE_ID" ]; then
        WORKSPACE_ID="$arg"
      fi
      ;;
  esac
done

if [ -z "$WORKSPACE_ID" ]; then
  echo "FAIL: WORKSPACE_ID env var or first positional arg is required."
  exit 2
fi

if [ -z "$MODE_FLAG" ]; then
  echo "FAIL: pass --dry-run OR --apply (defensive — no implicit live runs)."
  exit 2
fi

SCRIPTS=(
  "manual-count-burst"
  "webhook-flood"
  "concurrent-count-session"
  "fanout-storm"
  "reconcile-chaos"
  "bulk-create-locations-burst"
)

declare -a FAILURES=()

for s in "${SCRIPTS[@]}"; do
  echo ""
  echo "==> stress: $s"
  EXTRA=""
  if [ "$s" = "reconcile-chaos" ] && [ "$MODE_FLAG" = "--apply" ]; then
    EXTRA="--force-debug-bypass"
    export STRESS_HARNESS=1
  fi
  if npx tsx "scripts/stress/${s}.ts" --workspace="$WORKSPACE_ID" $MODE_FLAG $EXTRA; then
    echo "    [PASS] $s"
  else
    echo "    [FAIL] $s"
    FAILURES+=("$s")
  fi
done

echo ""
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "All stress scripts completed."
  exit 0
fi
echo "Stress run completed with failures:"
for f in "${FAILURES[@]}"; do
  echo "  - $f"
done
exit 1
