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
//      from `bandcamp-sale-poll.ts` (this file).
//   2. Include `'bandcamp'` in `SHIPSTATION_V2_ECHO_SOURCES` inside
//      `src/lib/server/inventory-fanout.ts` so the v2 leg of fanout also
//      skips. (Asserted in `inventory-fanout.test.ts`.)
//
// If a future change ever needs the explicit enqueue back (e.g. SS Inventory
// Sync is disabled per-workspace), BOTH layers must be reverted together.
// This static-source guard catches the easy half (a stray re-introduction
// of the trigger call); the fanout test catches the other half.

const SOURCE_PATH = path.resolve(process.cwd(), "src/trigger/tasks/bandcamp-sale-poll.ts");

describe("bandcamp-sale-poll — does not enqueue shipstation-v2-decrement (Rule #65 audit fix)", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");

  it("source file does NOT call tasks.trigger('shipstation-v2-decrement', …)", () => {
    // Match the trigger call regardless of quoting style or whitespace.
    const triggerCallPattern = /tasks\.trigger\(\s*["'`]shipstation-v2-decrement["'`]/;
    expect(source).not.toMatch(triggerCallPattern);
  });

  it("source file does NOT import or reference the v2 decrement task name as a string literal", () => {
    // Catch sneaky re-introductions like a const ssDecrementTaskId = "shipstation-v2-decrement".
    const literalCount = (source.match(/shipstation-v2-decrement/g) ?? []).length;
    // The only allowed mention is the explanatory comment block describing
    // why we no longer enqueue it. Allow up to 2 textual mentions inside
    // comments; assert NONE of them is a `tasks.trigger(...)` call (covered
    // by the previous test).
    expect(literalCount).toBeLessThanOrEqual(2);
  });

  it("still enqueues bandcamp + multi-store push tasks after a successful sale", () => {
    // Sanity check — we removed v2, not the whole post-sale fanout.
    expect(source).toMatch(/tasks\.trigger\(\s*["'`]bandcamp-inventory-push["'`]/);
    expect(source).toMatch(/tasks\.trigger\(\s*["'`]multi-store-inventory-push["'`]/);
  });
});
