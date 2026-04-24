#!/usr/bin/env bash
# Phase 4 Sub-pass A.2 scheduled burst — Run #2 of the X-1 gate.
# Fires at 2026-04-24T16:00:00Z. Logs everything to a single file so the
# parent agent can poll status at any point.
set -uo pipefail

LOG=reports/phase4-burst/run2-scheduler.log
TARGET_UTC="2026-04-24T16:00:00Z"

echo "[$(date -u +%FT%TZ)] scheduler started, target=$TARGET_UTC" >> "$LOG"

NOW=$(date -u +%s)
TARGET=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$TARGET_UTC" +%s 2>/dev/null || gdate -u -d "$TARGET_UTC" +%s)
DELTA=$(( TARGET - NOW ))
if [ "$DELTA" -lt 0 ]; then
  echo "[$(date -u +%FT%TZ)] target is in the past, firing immediately" >> "$LOG"
  DELTA=0
fi
echo "[$(date -u +%FT%TZ)] sleeping $DELTA seconds (~$((DELTA/3600))h $(( (DELTA%3600)/60 ))m)" >> "$LOG"
sleep "$DELTA"

echo "[$(date -u +%FT%TZ)] firing burst run #2…" >> "$LOG"
npx -y tsx@latest scripts/_phase4-burst-test.ts --apply --scale=full --label=run2 >> "$LOG" 2>&1
BURST_EXIT=$?
echo "[$(date -u +%FT%TZ)] burst exited code=$BURST_EXIT" >> "$LOG"

echo "[$(date -u +%FT%TZ)] firing cleanup (label=run2)…" >> "$LOG"
npx -y tsx@latest scripts/_phase4-burst-cleanup.ts --apply --label=run2 >> "$LOG" 2>&1
CLEANUP_EXIT=$?
echo "[$(date -u +%FT%TZ)] cleanup exited code=$CLEANUP_EXIT" >> "$LOG"

echo "[$(date -u +%FT%TZ)] scheduler done; report at reports/phase4-burst/*-run2.json" >> "$LOG"
