import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// === Static-source regression guard (2026-04-13 second-pass audit) ===
//
// `bandcamp-sale-poll` used to enqueue `shipstation-v2-decrement` after each
// successful Bandcamp sale `recordInventoryChange()`. With ShipStation
// Inventory Sync now active for the native Bandcamp store integration, SS
// imports the Bandcamp order and decrements v2 itself before this poll fires.
// Enqueuing here would double-decrement v2 (Rule #65 echo loop).
//
// The fix is two-layered and the layers MUST stay in sync:
//   1. Remove the explicit `tasks.trigger("shipstation-v2-decrement", …)`
//      from the per-connection runner module that both the cron task and
//      the per-connection event task delegate to.
//   2. Include `'bandcamp'` in `SHIPSTATION_V2_ECHO_SOURCES` inside
//      `src/lib/server/inventory-fanout.ts` so the v2 leg of fanout also
//      skips. (Asserted in `inventory-fanout.test.ts`.)
//
// If a future change ever needs the explicit enqueue back (e.g. SS Inventory
// Sync is disabled per-workspace), BOTH layers must be reverted together.
// This static-source guard catches the easy half (a stray re-introduction
// of the trigger call); the fanout test catches the other half.
//
// Phase 2 §9.3 D3 NOTE: the per-sale fanout body moved from
// `src/trigger/tasks/bandcamp-sale-poll.ts` into the shared runner at
// `src/trigger/lib/bandcamp-sale-poll-runner.ts` so the cron task and the
// event-driven `bandcamp-sale-poll-per-connection` task share an identical
// post-sale contract. We therefore scan BOTH files for the v2 mention to
// guarantee a stray re-introduction in either entry point fails CI, and
// the post-sale push assertions below scan the runner where they now live.

const TASK_SOURCE_PATH = path.resolve(process.cwd(), "src/trigger/tasks/bandcamp-sale-poll.ts");
const PER_CONN_SOURCE_PATH = path.resolve(
  process.cwd(),
  "src/trigger/tasks/bandcamp-sale-poll-per-connection.ts",
);
const RUNNER_SOURCE_PATH = path.resolve(
  process.cwd(),
  "src/trigger/lib/bandcamp-sale-poll-runner.ts",
);

describe("bandcamp-sale-poll — does not enqueue shipstation-v2-decrement (Rule #65 audit fix)", () => {
  const taskSource = readFileSync(TASK_SOURCE_PATH, "utf8");
  const perConnSource = readFileSync(PER_CONN_SOURCE_PATH, "utf8");
  const runnerSource = readFileSync(RUNNER_SOURCE_PATH, "utf8");
  const allSources = [taskSource, perConnSource, runnerSource];

  it("none of the sale-poll source files call tasks.trigger('shipstation-v2-decrement', …)", () => {
    const triggerCallPattern = /tasks\.trigger\(\s*["'`]shipstation-v2-decrement["'`]/;
    for (const src of allSources) {
      expect(src).not.toMatch(triggerCallPattern);
    }
  });

  it("none of the sale-poll source files reference the v2 decrement task id beyond explanatory comments", () => {
    for (const src of allSources) {
      const literalCount = (src.match(/shipstation-v2-decrement/g) ?? []).length;
      // Allow a handful of textual mentions inside comment blocks (the
      // runner has the long Rule #65 explanation). The previous test
      // already proves none of them is a `tasks.trigger(...)` call.
      expect(literalCount).toBeLessThanOrEqual(2);
    }
  });

  it("the runner still enqueues bandcamp + multi-store push tasks after a successful sale", () => {
    expect(runnerSource).toMatch(/tasks\.trigger\(\s*["'`]bandcamp-inventory-push["'`]/);
    expect(runnerSource).toMatch(/tasks\.trigger\(\s*["'`]multi-store-inventory-push["'`]/);
  });

  it("both the cron task and the per-connection task delegate to the shared runner", () => {
    // Static guarantee that the two entry points share the body — if
    // someone forks the loop in one of them, this test fails and the
    // ShipStation echo guarantee above stops being a valid invariant.
    expect(taskSource).toMatch(/pollOneBandcampConnection/);
    expect(perConnSource).toMatch(/pollOneBandcampConnection/);
  });
});
