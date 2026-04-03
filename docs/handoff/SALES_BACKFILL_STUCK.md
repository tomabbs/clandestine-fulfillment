# Sales Backfill Tasks Not Executing

## Problem

The `bandcamp-sales-backfill` task never starts when triggered via the Trigger.dev REST API. Runs stay in `QUEUED` status until they expire (default TTL 10 minutes). Even with TTL extended to 1 hour, runs never transition to `EXECUTING`.

Meanwhile, **cron-scheduled tasks work perfectly** — `bandcamp-sale-poll` (every 5 min), `bandcamp-scrape-sweep` (every 10 min), `bandcamp-sync-cron` (every 30 min), and `bandcamp-sales-sync` (daily 5am) all execute normally. Only API-triggered on-demand tasks are affected.

## Evidence

```
# Multiple trigger attempts — all QUEUED, never started:
run_cmnhtid6q92vt0imspnmz8un8  EXPIRED  TTL 10m  (2026-04-02, bandcamp-api queue)
run_cmnhtidaz9afr0on3n6st7cfn  EXPIRED  TTL 10m  (2026-04-02, bandcamp-api queue)
run_cmnjb84vu8kms0in9dypxcnxa  EXPIRED  TTL 10m  (2026-04-03, default queue)
run_cmnjb84zp80nj0ioh6siiz8cv  EXPIRED  TTL 10m  (2026-04-03, default queue)
run_cmnjbt2pi8lou0uon5pr7pfum  QUEUED   TTL 1h   (2026-04-03, default queue)
run_cmnjbvcwe88ou0uon5pr7pfum  QUEUED   TTL 1h   (2026-04-03, custom queue name)
run_cmnjby4yt83x00iolfveuct83  QUEUED   TTL 1h   (2026-04-03, default queue)

# Test with a different task (debug-env) — same result:
run_cmnjbxi3j8lqy0oooojfc8jlx  QUEUED   TTL 5m   (never started)

# But cron tasks run fine at the same time:
sale_poll       completed   @ 20:01:39
scrape_page     completed   @ 20:01:03 (multiple)
scrape_sweep    completed   @ 20:00:41

# Daily sales sync (cron) DID work:
sales_sync      completed   proc: 1   @ 05:06:09 (inserted 1 sale row)
```

## What Works vs What Doesn't

| Trigger method | Works? | Example |
|---|---|---|
| `schedules.task()` with cron | **YES** | `bandcamp-sale-poll`, `bandcamp-sales-sync`, `sensor-check` |
| `task()` triggered by another task (e.g. `bandcampScrapePageTask.trigger()` from within sync) | **YES** | `bandcamp-scrape-page` triggers work from sweep/sync |
| `task()` triggered via REST API `/api/v1/tasks/{id}/trigger` | **NO** | Every attempt stays QUEUED |

## Trigger.dev Configuration

```typescript
// trigger.config.ts
export default defineConfig({
  project: "proj_lxmzyqttdjjukmshplok",
  dirs: ["src/trigger/tasks"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      factor: 2,
    },
  },
  // ... syncEnvVars, Sentry
});
```

Latest deployment: **version 20260403.1**, 56 detected tasks.

## Task Code

### `bandcamp-sales-backfill.ts` (240 lines)

```typescript
import { task } from "@trigger.dev/sdk";
import {
  generateSalesReport,
  fetchSalesReport,
  refreshBandcampToken,
  type SalesReportItem,
} from "@/lib/clients/bandcamp";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// NOTE: No queue specified — runs on default queue.
// Previously had `queue: bandcampQueue` which caused TTL expiry
// because the bandcamp-api queue (concurrency 1) was always busy
// with sale-poll and sync tasks. Removed in commit cbe6ac9.

export const bandcampSalesBackfillTask = task({
  id: "bandcamp-sales-backfill",
  maxDuration: 300,  // 5 min per yearly chunk
  run: async (payload: { connectionId: string; workspaceId: string }) => {
    // ... (see full code below)
  },
});
```

**Full task code is in:** `src/trigger/tasks/bandcamp-sales-backfill.ts`

The task:
1. Reads `bandcamp_sales_backfill_state` for the connection to find where it left off
2. Processes one year of sales data per run (2010→2011, 2011→2012, etc.)
3. Calls `generateSalesReport()` then polls `fetchSalesReport()` until ready
4. Downloads the report from the returned URL, parses JSON
5. Upserts into `bandcamp_sales` table (batches of 100)
6. Backfills `catalog_number`/`upc` to `bandcamp_product_mappings`
7. Self-triggers for the next yearly chunk
8. Marks `status: "completed"` when it reaches the current date

### `bandcamp-sales-sync.ts` (134 lines) — THIS ONE WORKS (cron)

```typescript
import { schedules } from "@trigger.dev/sdk";

export const bandcampSalesSyncSchedule = schedules.task({
  id: "bandcamp-sales-sync",
  cron: "0 5 * * *",
  queue: bandcampQueue,  // Uses bandcamp-api queue — works because it's a scheduled task
  maxDuration: 300,
  run: async () => {
    // Pulls yesterday's sales via synchronous sales_report
    // This DID execute at 5am and inserted 1 row
  },
});
```

### Trigger API Call Pattern (what we're using)

```bash
curl -X POST https://api.trigger.dev/api/v1/tasks/bandcamp-sales-backfill/trigger \
  -H "Authorization: Bearer $TRIGGER_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "connectionId": "f8f6df37-d84c-4065-9004-84e466e92a00",
      "workspaceId": "00f10a94-20f4-4e13-8820-d56fbff11641"
    },
    "options": { "ttl": "1h" }
  }'
```

Returns `{"id":"run_xxx","isCached":false}` (HTTP 200) but the run never starts.

## Hypotheses

### H1: API-triggered runs are routed to a different deployment/environment
The v1 trigger API may be routing runs to a non-production deployment or a test environment where no workers are listening. Cron schedules are attached to the production deployment explicitly.

**Check:** In Trigger.dev dashboard, look at the QUEUED runs — what deployment version and environment are they assigned to?

### H2: The task needs to be explicitly registered for API triggering
Some Trigger.dev versions require tasks to be explicitly marked as externally triggerable. `schedules.task()` and inter-task `.trigger()` calls may bypass this, while REST API calls require it.

**Check:** Look for Trigger.dev docs on `triggerSource` or task visibility settings. Some tasks may need `triggerSource: "api"` or similar.

### H3: The `TRIGGER_SECRET_KEY` environment variable is for a different project/environment
If the secret key maps to a dev environment but deploys went to prod, runs get created in the wrong environment.

**Check:** Compare the project ID in `trigger.config.ts` (`proj_lxmzyqttdjjukmshplok`) with the project the secret key belongs to. Check environment (dev vs prod vs staging).

### H4: Default queue concurrency is 0 or disabled
If no explicit queue is set, the task runs on the default queue. If the default queue has no workers assigned or concurrency is set to 0, runs queue forever.

**Check:** In Trigger.dev dashboard, check Queues section for the default queue configuration.

### H5: The task is registered but the worker isn't picking up on-demand tasks
The Trigger.dev worker process may only poll for scheduled tasks and internally-triggered tasks. External API triggers may use a different dispatch mechanism that's not active.

**Check:** Try triggering `bandcamp-sales-backfill` from within a running scheduled task (e.g. add a trigger call inside `bandcamp-sales-sync` temporarily).

## Recommended Next Steps

1. **Check Trigger.dev dashboard** — look at the QUEUED runs, see what deployment/environment they're assigned to
2. **Try triggering from inside a cron task** — if this works, it confirms the REST API routing is the issue
3. **Contact Trigger.dev support** — this may be a platform bug or configuration issue
4. **Workaround: convert backfill to a temporary cron** — add a cron schedule to the backfill task that runs once, let the scheduler pick it up

## Workaround Code (if needed)

Convert the backfill to a cron that processes all connections:

```typescript
// Temporary: add to bandcamp-sales-backfill.ts
export const bandcampSalesBackfillCron = schedules.task({
  id: "bandcamp-sales-backfill-cron",
  cron: "30 * * * *",  // Every hour at :30
  maxDuration: 300,
  run: async () => {
    const supabase = createServiceRoleClient();
    const { data: conns } = await supabase
      .from("bandcamp_connections")
      .select("id, workspace_id")
      .eq("is_active", true);
    
    for (const conn of conns ?? []) {
      // Check if already completed
      const { data: state } = await supabase
        .from("bandcamp_sales_backfill_state")
        .select("status")
        .eq("connection_id", conn.id)
        .single();
      
      if (state?.status === "completed") continue;
      
      // Run one chunk inline (not via .trigger())
      await runBackfillChunk(conn.id, conn.workspace_id);
    }
  },
});
```

This bypasses the REST API entirely — the cron scheduler will pick it up like all other scheduled tasks.
