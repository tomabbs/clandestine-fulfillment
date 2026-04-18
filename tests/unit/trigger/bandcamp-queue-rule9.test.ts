import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Rule #9 (CLAUDE.md) — Bandcamp OAuth queue serialization.
 *
 * EVERY Trigger.dev task that calls `refreshBandcampToken()` or any other
 * OAuth-bearing Bandcamp API helper (`salesReport`, `getMerchDetails`,
 * `updateQuantities`, `updateSku`, `getOrders`, `updateShipped`,
 * `getShippingOriginDetails`, etc.) MUST be pinned to the shared
 * `bandcampQueue` (`name: "bandcamp-api"`, `concurrencyLimit: 1`).
 *
 * Without serialization, two concurrent token refreshes return distinct
 * access tokens, the older one is invalidated by the next refresh, and
 * subsequent calls receive `duplicate_grant` — which destroys the OAuth
 * token family and requires manual re-authentication in Bandcamp.
 *
 * This regression test was added as part of the Phase 0.0 hotfix.
 */

const TASK_DIR = resolve(__dirname, "../../../src/trigger/tasks");

interface TaskExpectation {
  /** Source file under src/trigger/tasks/ */
  file: string;
  /** Variable identifier in the export statement */
  exportName: string;
  /** Constructor used: `task` or `schedules.task` */
  constructor: "task" | "schedules.task";
  /** What queue the task MUST be pinned to */
  expectedQueue: "bandcampQueue" | "bandcampScrapeQueue" | "bandcampSweepQueue";
  /** Why this queue is required */
  rationale: string;
}

/**
 * Source of truth for Rule #9 compliance.
 *
 * To add a new Bandcamp task: append an entry here. CI will fail until the
 * task source declares the matching `queue:` line.
 */
const BANDCAMP_TASK_REGISTRY: TaskExpectation[] = [
  // ─── OAuth-bearing tasks (MUST be on bandcampQueue) ─────────────────────
  {
    file: "bandcamp-sync.ts",
    exportName: "bandcampSyncTask",
    constructor: "task",
    expectedQueue: "bandcampQueue",
    rationale: "Calls refreshBandcampToken + getMerchDetails (OAuth)",
  },
  {
    file: "bandcamp-sync.ts",
    exportName: "bandcampSyncSchedule",
    constructor: "schedules.task",
    expectedQueue: "bandcampQueue",
    rationale: "Triggers bandcamp-sync (OAuth) per connection",
  },
  {
    file: "bandcamp-sale-poll.ts",
    exportName: "bandcampSalePollTask",
    constructor: "schedules.task",
    expectedQueue: "bandcampQueue",
    rationale: "Calls refreshBandcampToken + getOrders (OAuth)",
  },
  {
    file: "bandcamp-sales-sync.ts",
    exportName: "bandcampSalesSyncSchedule",
    constructor: "schedules.task",
    expectedQueue: "bandcampQueue",
    rationale: "Calls refreshBandcampToken + salesReport (OAuth)",
  },
  {
    file: "bandcamp-order-sync.ts",
    exportName: "bandcampOrderSyncTask",
    constructor: "task",
    expectedQueue: "bandcampQueue",
    rationale: "Calls refreshBandcampToken + getOrders (OAuth)",
  },
  {
    file: "bandcamp-order-sync.ts",
    exportName: "bandcampOrderSyncSchedule",
    constructor: "schedules.task",
    expectedQueue: "bandcampQueue",
    rationale: "Schedules order sync (OAuth) per connection",
  },
  {
    file: "bandcamp-mark-shipped.ts",
    exportName: "bandcampMarkShippedTask",
    constructor: "task",
    expectedQueue: "bandcampQueue",
    rationale: "Calls refreshBandcampToken + updateShipped (OAuth)",
  },
  {
    file: "bandcamp-mark-shipped.ts",
    exportName: "bandcampMarkShippedSchedule",
    constructor: "schedules.task",
    expectedQueue: "bandcampQueue",
    rationale: "Schedules mark-shipped (OAuth) per connection",
  },
  {
    file: "bandcamp-inventory-push.ts",
    exportName: "bandcampInventoryPushTask",
    constructor: "schedules.task",
    expectedQueue: "bandcampQueue",
    rationale: "Calls refreshBandcampToken + updateQuantities/updateSku (OAuth)",
  },
  {
    file: "bandcamp-sales-backfill.ts",
    exportName: "bandcampSalesBackfillTask",
    constructor: "task",
    expectedQueue: "bandcampQueue",
    rationale: "Deprecated; pinned for defense-in-depth (Phase 0.0 hotfix)",
  },
  {
    file: "bandcamp-sales-backfill.ts",
    exportName: "bandcampSalesBackfillCron",
    constructor: "schedules.task",
    expectedQueue: "bandcampQueue",
    rationale: "Calls refreshBandcampToken + salesReport (Phase 0.0 hotfix)",
  },

  // ─── HTML-only scraping tasks (separate queues, NOT OAuth) ──────────────
  {
    file: "bandcamp-sync.ts",
    exportName: "bandcampScrapePageTask",
    constructor: "task",
    expectedQueue: "bandcampScrapeQueue",
    rationale: "HTML-only scrape called from bandcampSyncTask; separate queue",
  },
  {
    file: "bandcamp-tag-backfill.ts",
    exportName: "bandcampTagBackfillTask",
    constructor: "task",
    expectedQueue: "bandcampScrapeQueue",
    rationale: "HTML-only scrape, independent queue",
  },
  {
    file: "bandcamp-scrape-sweep.ts",
    exportName: "bandcampScrapeSweepTask",
    constructor: "schedules.task",
    expectedQueue: "bandcampSweepQueue",
    rationale: "HTML-only scrape, independent sweep queue",
  },
];

interface ParsedDeclaration {
  body: string;
  hasQueueLine: boolean;
  queueValue: string | null;
}

/**
 * Extracts the options object passed to `task({...})` or
 * `schedules.task({...})` for a given exported identifier.
 */
function parseTaskDeclaration(
  source: string,
  exportName: string,
  ctor: "task" | "schedules.task",
): ParsedDeclaration | null {
  // Match: export const NAME = task({  ...balanced...  });
  //    or: export const NAME = schedules.task({  ...balanced...  });
  const ctorPattern = ctor === "task" ? "task" : "schedules\\.task";
  const declStart = new RegExp(
    `export\\s+const\\s+${exportName}\\s*=\\s*${ctorPattern}\\s*\\(\\s*\\{`,
  );
  const m = declStart.exec(source);
  if (!m) return null;

  // Walk forward from the opening `{` of the options object, tracking depth.
  let depth = 1;
  let i = m.index + m[0].length;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;

  const body = source.slice(m.index + m[0].length, i - 1);

  // Match `queue: <expression>,` only as a top-level property (depth 0).
  // We do a depth-aware scan to avoid matching `queue:` inside nested literals.
  let qDepth = 0;
  let queueValue: string | null = null;
  for (let j = 0; j < body.length; j++) {
    const ch = body[j];
    if (ch === "{" || ch === "[" || ch === "(") qDepth++;
    else if (ch === "}" || ch === "]" || ch === ")") qDepth--;
    else if (qDepth === 0 && body.slice(j).startsWith("queue:")) {
      const rest = body.slice(j + "queue:".length);
      const valueMatch = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rest);
      if (valueMatch) {
        queueValue = valueMatch[1];
        break;
      }
    }
  }

  return {
    body,
    hasQueueLine: queueValue !== null,
    queueValue,
  };
}

describe("Rule #9 — Bandcamp queue serialization (regression guard)", () => {
  for (const entry of BANDCAMP_TASK_REGISTRY) {
    const label = `${entry.file} :: ${entry.exportName} → queue: ${entry.expectedQueue}`;
    it(label, () => {
      const source = readFileSync(resolve(TASK_DIR, entry.file), "utf8");
      const parsed = parseTaskDeclaration(source, entry.exportName, entry.constructor);

      expect(parsed, `Could not locate ${entry.exportName} in ${entry.file}`).not.toBeNull();
      expect(
        parsed?.hasQueueLine,
        `${entry.exportName} is missing a top-level \`queue:\` property — ${entry.rationale}`,
      ).toBe(true);
      expect(
        parsed?.queueValue,
        `${entry.exportName} must be pinned to \`${entry.expectedQueue}\` — ${entry.rationale}`,
      ).toBe(entry.expectedQueue);
    });
  }

  it("imports the shared bandcampQueue (not a per-file ad-hoc queue)", () => {
    // Every OAuth-bearing file must import bandcampQueue from the canonical path.
    const oauthFiles = Array.from(
      new Set(
        BANDCAMP_TASK_REGISTRY.filter((e) => e.expectedQueue === "bandcampQueue").map(
          (e) => e.file,
        ),
      ),
    );
    for (const file of oauthFiles) {
      const source = readFileSync(resolve(TASK_DIR, file), "utf8");
      expect(
        /from\s+["']@\/trigger\/lib\/bandcamp-queue["']/.test(source),
        `${file} must import bandcampQueue from @/trigger/lib/bandcamp-queue`,
      ).toBe(true);
      expect(/\bbandcampQueue\b/.test(source), `${file} must reference bandcampQueue`).toBe(true);
    }
  });

  it("bandcampQueue is defined with concurrencyLimit: 1", () => {
    const queueSource = readFileSync(
      resolve(__dirname, "../../../src/trigger/lib/bandcamp-queue.ts"),
      "utf8",
    );
    expect(queueSource).toMatch(/name:\s*["']bandcamp-api["']/);
    expect(queueSource).toMatch(/concurrencyLimit:\s*1\b/);
  });
});
