import { logger, task } from "@trigger.dev/sdk";
import { z } from "zod";
import { runSkuAutonomousDryRun } from "@/lib/server/sku-autonomous-dry-run";

const dryRunPayloadSchema = z
  .object({
    workspaceId: z.string().uuid().optional(),
    connectionId: z.string().uuid().optional(),
    triggeredBy: z.string().min(1).max(200).optional(),
    triggerSource: z
      .enum([
        "manual_admin",
        "scheduled_periodic",
        "connection_added",
        "evidence_change_trigger",
        "stock_change_trigger",
      ])
      .optional(),
    limitPerConnection: z.number().int().positive().max(10_000).optional(),
  })
  .default({});

export const skuAutonomousDryRunTask = task({
  id: "sku-autonomous-dry-run",
  maxDuration: 900,
  run: async (payload: unknown) => {
    const input = dryRunPayloadSchema.parse(payload);
    const result = await runSkuAutonomousDryRun({
      ...input,
      triggeredBy: input.triggeredBy ?? "sku-autonomous-dry-run",
    });

    logger.info("sku-autonomous-dry-run completed", {
      connectionsScanned: result.connectionsScanned,
      connectionsSkippedPaused: result.connectionsSkippedPaused,
      runsOpened: result.runsOpened,
      variantsEvaluated: result.variantsEvaluated,
      decisionsWritten: result.decisionsWritten,
      candidatesWithNoMatch: result.candidatesWithNoMatch,
      candidatesWithDisqualifiers: result.candidatesWithDisqualifiers,
      errors: result.errors,
    });

    return result;
  },
});
