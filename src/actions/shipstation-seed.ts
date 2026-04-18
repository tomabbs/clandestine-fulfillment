"use server";

/**
 * ShipStation v2 seed Server Actions — Phase 3 (plan §7.1.5).
 *
 * Two staff-only verbs:
 *
 * - `previewShipStationSeed({ workspaceId, inventoryWarehouseId,
 *    inventoryLocationId })` — runs the seed task in `dryRun: true` mode
 *   via `tasks.triggerAndPoll` so the admin UI can render counts before
 *   the operator commits to writing to ShipStation.
 *
 * - `triggerShipStationSeed({ workspaceId, inventoryWarehouseId,
 *    inventoryLocationId })` — enqueues the real seed run on the
 *   `shipstation` queue (concurrencyLimit: 1, shared with
 *   `process-shipstation-shipment`). Returns the task run id so the UI
 *   can poll the existing `channel_sync_log` for progress.
 *
 * - `listShipStationSeedRuns({ workspaceId })` — read for the admin
 *   "Recent runs" panel (queries `channel_sync_log`).
 *
 * Rule #41: Server Actions must NOT do unbounded work. Seeding hundreds
 * of SKUs per workspace easily exceeds 60s, so both writes route to
 * Trigger.dev and the UI polls.
 *
 * Rule #48: Server Actions never call ShipStation directly — always
 * enqueue via `tasks.trigger`.
 */

import { runs, tasks } from "@trigger.dev/sdk";
import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type {
  ShipstationSeedPayload,
  ShipstationSeedResult,
} from "@/trigger/tasks/shipstation-seed-inventory";

const SEED_INPUT = z.object({
  workspaceId: z.string().uuid(),
  inventoryWarehouseId: z.string().min(1),
  inventoryLocationId: z.string().min(1),
});

export interface TriggerSeedResult {
  status: "queued";
  taskRunId: string;
  workspaceId: string;
}

async function assertStaffOwnsWorkspace(workspaceId: string): Promise<void> {
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");
  if (workspaceId !== ctx.userRecord.workspace_id) {
    throw new Error("Cross-workspace seed not permitted");
  }
}

/**
 * Dry-run preview. Triggers the seed task with `dryRun: true` and polls
 * for the result inline. The dry-run path does NOT call ShipStation —
 * it only evaluates the gate cascade against Postgres — so this typically
 * completes in <2s for workspaces with up to ~500 variants. We cap the
 * inline wait at 25s (Server Actions should stay bounded — Rule #41) and
 * return a run-id-only result if the preview takes longer; the operator
 * UI then falls back to polling `listShipStationSeedRuns`.
 */
export interface PreviewSeedResult {
  status: "completed" | "pending";
  taskRunId: string;
  output?: ShipstationSeedResult;
}

const PREVIEW_INLINE_TIMEOUT_MS = 25_000;
const PREVIEW_POLL_INTERVAL_MS = 750;

export async function previewShipStationSeed(
  input: z.input<typeof SEED_INPUT>,
): Promise<PreviewSeedResult> {
  const parsed = SEED_INPUT.parse(input);
  await assertStaffOwnsWorkspace(parsed.workspaceId);

  const payload: ShipstationSeedPayload = {
    workspaceId: parsed.workspaceId,
    inventoryWarehouseId: parsed.inventoryWarehouseId,
    inventoryLocationId: parsed.inventoryLocationId,
    dryRun: true,
  };

  const handle = await tasks.trigger("shipstation-seed-inventory", payload);

  const startedAt = Date.now();
  while (Date.now() - startedAt < PREVIEW_INLINE_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, PREVIEW_POLL_INTERVAL_MS));
    const run = await runs.retrieve(handle.id);
    const status = run.status as string;
    if (status === "COMPLETED" || status === "SUCCEEDED") {
      return {
        status: "completed",
        taskRunId: handle.id,
        output: run.output as ShipstationSeedResult,
      };
    }
    if (status === "FAILED" || status === "CANCELED" || status === "CRASHED") {
      throw new Error(`Preview failed: ${status}`);
    }
  }

  return { status: "pending", taskRunId: handle.id };
}

/**
 * Real seed. Returns immediately with the task run id; the operator UI
 * polls `listShipStationSeedRuns` for progress.
 */
export async function triggerShipStationSeed(
  input: z.input<typeof SEED_INPUT>,
): Promise<TriggerSeedResult> {
  const parsed = SEED_INPUT.parse(input);
  await assertStaffOwnsWorkspace(parsed.workspaceId);

  const payload: ShipstationSeedPayload = {
    workspaceId: parsed.workspaceId,
    inventoryWarehouseId: parsed.inventoryWarehouseId,
    inventoryLocationId: parsed.inventoryLocationId,
    dryRun: false,
  };

  const handle = await tasks.trigger("shipstation-seed-inventory", payload);

  return {
    status: "queued",
    taskRunId: handle.id,
    workspaceId: parsed.workspaceId,
  };
}

// ─── Recent runs panel ───────────────────────────────────────────────────────

const LIST_INPUT = z.object({
  workspaceId: z.string().uuid(),
  limit: z.number().int().min(1).max(50).optional(),
});

export interface SeedRunRow {
  id: string;
  status: string;
  items_processed: number | null;
  items_failed: number | null;
  started_at: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown> | null;
}

export async function listShipStationSeedRuns(
  input: z.input<typeof LIST_INPUT>,
): Promise<SeedRunRow[]> {
  const parsed = LIST_INPUT.parse(input);
  await assertStaffOwnsWorkspace(parsed.workspaceId);

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("channel_sync_log")
    .select("id, status, items_processed, items_failed, started_at, completed_at, metadata")
    .eq("workspace_id", parsed.workspaceId)
    .eq("channel", "shipstation_v2")
    .eq("sync_type", "seed_inventory")
    .order("started_at", { ascending: false })
    .limit(parsed.limit ?? 10);

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SeedRunRow[];
}
