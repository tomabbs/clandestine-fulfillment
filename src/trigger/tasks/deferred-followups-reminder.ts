/**
 * Phase 6 closeout — daily reminder cron.
 *
 * Parses `docs/DEFERRED_FOLLOWUPS.md` (YAML front matter listing each
 * deferred entry with `slug`, `title`, `due_date`, `severity`, `context`)
 * and upserts a `warehouse_review_queue` item per workspace for every entry
 * whose `due_date <= today`. Idempotent via the `group_key` UNIQUE constraint
 * (`uq_review_queue_group_key` from migration 20260401000003).
 *
 * Plan reference: §C.4. The DEFERRED_FOLLOWUPS.md file is bundled into the
 * Trigger build via the `additionalFiles` extension declared in
 * `trigger.config.ts` so `readFile` works in Trigger's isolated runtime.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { logger, schedules } from "@trigger.dev/sdk";
import { parse as yamlParse } from "yaml";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface DeferredEntry {
  slug: string;
  title: string;
  due_date: string;
  severity: "low" | "medium" | "high" | "critical";
  context: string;
}

export const deferredFollowupsReminderTask = schedules.task({
  id: "deferred-followups-reminder",
  // Daily 09:00 UTC (~04:00 ET). Operator can shift later via the
  // Trigger.dev dashboard once they pick a preferred local time.
  cron: "0 9 * * *",
  run: async () => {
    const filePath = path.join(process.cwd(), "docs", "DEFERRED_FOLLOWUPS.md");
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      logger.error("[deferred-followups-reminder] could not read DEFERRED_FOLLOWUPS.md", {
        filePath,
        err,
      });
      throw err;
    }

    const yamlBlock = raw.match(/^---\n([\s\S]+?)\n---/);
    if (!yamlBlock) {
      throw new Error("DEFERRED_FOLLOWUPS.md is missing the YAML front matter block (--- ... ---)");
    }

    const parsed = yamlParse(yamlBlock[1]);
    if (!Array.isArray(parsed)) {
      throw new Error(
        "DEFERRED_FOLLOWUPS.md YAML front matter must be a YAML sequence (top-level array of entries).",
      );
    }
    const entries = parsed as DeferredEntry[];
    const today = new Date().toISOString().slice(0, 10);

    const supabase = createServiceRoleClient();
    const { data: workspaces, error: wsErr } = await supabase.from("workspaces").select("id");
    if (wsErr) {
      logger.error("[deferred-followups-reminder] failed to load workspaces", { error: wsErr });
      throw wsErr;
    }
    const workspaceIds = (workspaces ?? []).map((w) => w.id);

    let dueCount = 0;
    let upsertedCount = 0;
    for (const entry of entries) {
      if (!isValidEntry(entry)) {
        logger.warn("[deferred-followups-reminder] skipping malformed entry", { entry });
        continue;
      }
      if (entry.due_date > today) continue;
      dueCount += 1;

      for (const wsId of workspaceIds) {
        const { error: upsertErr } = await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: wsId,
            category: "deferred_followup",
            severity: entry.severity,
            title: `Deferred follow-up due: ${entry.title}`,
            description: entry.context,
            metadata: {
              slug: entry.slug,
              due_date: entry.due_date,
              context: entry.context,
            },
            status: "open" as const,
            // group_key is UNIQUE per migration 20260401000003 so this upsert
            // is idempotent — the daily cron is safe to re-run any number of
            // times. Operator closes a queue item by setting status='resolved'.
            group_key: `deferred-followup-${entry.slug}`,
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: false },
        );
        if (upsertErr) {
          logger.error("[deferred-followups-reminder] upsert failed", {
            workspaceId: wsId,
            slug: entry.slug,
            error: upsertErr,
          });
        } else {
          upsertedCount += 1;
        }
      }
    }

    logger.info("[deferred-followups-reminder] complete", {
      totalEntries: entries.length,
      dueCount,
      workspaceCount: workspaceIds.length,
      upsertedCount,
    });
  },
});

function isValidEntry(entry: unknown): entry is DeferredEntry {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.slug === "string" &&
    typeof e.title === "string" &&
    typeof e.due_date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(e.due_date) &&
    typeof e.severity === "string" &&
    ["low", "medium", "high", "critical"].includes(e.severity) &&
    typeof e.context === "string"
  );
}
