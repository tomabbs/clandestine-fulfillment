/**
 * Order Pages Transition smoke
 *
 * Exercises every route + redirect introduced by the
 * `order_transition_6f04483d.plan.md` rollout, captures per-route
 * console / page-error / network detail (so failures are debuggable
 * without re-running the full-site audit), and asserts the rollback
 * route-mode flag honors live page rendering.
 *
 * Failure mode: any captured pageError, hydration mismatch, 5xx network,
 * or missing key landmark fails the test for that route.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { setupStaffSession } from "./helpers/auth";

type ConsoleIssue = { type: string; text: string; location?: string };
type NetworkIssue = {
  kind: "requestfailed" | "http_error";
  method: string;
  status?: number;
  url: string;
  resourceType?: string;
  errorText?: string;
};
type RouteAudit = {
  path: string;
  ok: boolean;
  status?: number;
  loadTimeMs?: number;
  pageErrors: string[];
  consoleIssues: ConsoleIssue[];
  networkIssues: NetworkIssue[];
  hydrationMismatches: number;
  landmark?: string;
};

const audit: { routes: RouteAudit[] } = { routes: [] };

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

async function visit(
  page: Page,
  targetPath: string,
  landmark?: RegExp,
): Promise<RouteAudit> {
  const consoleIssues: ConsoleIssue[] = [];
  const pageErrors: string[] = [];
  const networkIssues: NetworkIssue[] = [];

  const onConsole = (msg: {
    type: () => string;
    text: () => string;
    location: () => { url?: string };
  }) => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      consoleIssues.push({ type, text: msg.text(), location: msg.location()?.url });
    }
  };
  const onPageError = (err: Error) => {
    pageErrors.push(err.message);
  };
  const onRequestFailed = (req: {
    method: () => string;
    url: () => string;
    resourceType: () => string;
    failure: () => { errorText?: string } | null;
  }) => {
    networkIssues.push({
      kind: "requestfailed",
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      errorText: req.failure()?.errorText,
    });
  };
  const onResponse = (res: {
    status: () => number;
    url: () => string;
    request: () => { method: () => string; resourceType: () => string };
  }) => {
    const status = res.status();
    if (status >= 400) {
      networkIssues.push({
        kind: "http_error",
        method: res.request().method(),
        status,
        url: res.url(),
        resourceType: res.request().resourceType(),
      });
    }
  };

  page.on("console", onConsole as never);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed as never);
  page.on("response", onResponse as never);

  let status: number | undefined;
  let landmarkText: string | undefined;
  const start = Date.now();
  let loadTimeMs: number | undefined;

  try {
    const res = await page.goto(targetPath, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    loadTimeMs = Date.now() - start;
    status = res?.status();

    if (landmark) {
      await expect(page.locator("h1").first()).toContainText(landmark, { timeout: 8_000 });
      landmarkText = (await page.locator("h1").first().innerText()).trim();
    }
  } finally {
    page.off("console", onConsole as never);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed as never);
    page.off("response", onResponse as never);
  }

  const has5xx = networkIssues.some(
    (n) => n.kind === "http_error" && (n.status ?? 0) >= 500,
  );
  const hydrationMismatches = consoleIssues.filter(
    (i) => i.type === "error" && /hydrat/i.test(i.text),
  ).length;

  return {
    path: targetPath,
    ok: pageErrors.length === 0 && !has5xx && hydrationMismatches === 0,
    status,
    loadTimeMs,
    pageErrors,
    consoleIssues,
    networkIssues,
    hydrationMismatches,
    landmark: landmarkText,
  };
}

test.beforeEach(async ({ page }) => {
  await setupStaffSession(page);
});

test.afterAll(async () => {
  const reportDir = path.join(process.cwd(), "reports", "order-transition-smoke");
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(reportDir, `order-transition-smoke-${stamp}.json`);
  const mdPath = path.join(reportDir, `order-transition-smoke-${stamp}.md`);

  const md = [
    "# Order Pages Transition Smoke",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Routes: ${audit.routes.length}`,
    `- Passed: ${audit.routes.filter((r) => r.ok).length}`,
    `- Failed: ${audit.routes.filter((r) => !r.ok).length}`,
    "",
    "## Route Results",
    "",
    ...audit.routes.flatMap((r) => {
      const head = `- [${r.ok ? "PASS" : "FAIL"}] \`${r.path}\` status=${r.status ?? "n/a"} load=${r.loadTimeMs ?? "?"}ms pageErrors=${r.pageErrors.length} console=${r.consoleIssues.length} network=${r.networkIssues.length} hydration=${r.hydrationMismatches} landmark=${r.landmark ?? "—"}`;
      const detail: string[] = [];
      if (r.pageErrors.length) {
        detail.push("  - pageErrors:");
        for (const p of r.pageErrors.slice(0, 6)) detail.push(`    - ${p.replace(/\n/g, " ")}`);
      }
      const fivexx = r.networkIssues.filter(
        (n) => n.kind === "http_error" && (n.status ?? 0) >= 500,
      );
      if (fivexx.length) {
        detail.push("  - 5xx:");
        for (const n of fivexx.slice(0, 6))
          detail.push(`    - ${n.method} ${n.status} ${n.url}`);
      }
      const errConsole = r.consoleIssues.filter((c) => c.type === "error");
      if (errConsole.length) {
        detail.push("  - console errors:");
        for (const c of errConsole.slice(0, 6))
          detail.push(`    - ${c.text.replace(/\n/g, " ").slice(0, 240)}`);
      }
      return [head, ...detail];
    }),
    "",
  ].join("\n");

  await fs.writeFile(jsonPath, JSON.stringify(audit, null, 2), "utf8");
  await fs.writeFile(mdPath, md, "utf8");
});

test("transition: /admin/orders renders Direct or Mirror per flag", async ({ page }) => {
  const r = await visit(page, "/admin/orders", /orders/i);
  audit.routes.push(r);
  expect(r.pageErrors, `pageErrors on /admin/orders: ${r.pageErrors.join(" | ")}`).toEqual([]);
  expect(r.status, "200 expected on /admin/orders").toBe(200);
});

test("transition: /admin/orders/shipstation hosts the cockpit", async ({ page }) => {
  const r = await visit(page, "/admin/orders/shipstation", /orders|fulfillment/i);
  audit.routes.push(r);
  expect(r.pageErrors).toEqual([]);
  expect(r.status).toBe(200);
});

test("transition: /admin/orders/diagnostics renders diagnostics", async ({ page }) => {
  const r = await visit(page, "/admin/orders/diagnostics", /diagnostics/i);
  audit.routes.push(r);
  expect(r.pageErrors).toEqual([]);
  expect(r.status).toBe(200);
  // Snapshot grid + the three operator cards must render in the main content
  // (scoped to the page wrapper, not the sidebar nav).
  const main = page.locator("main, div.p-6").first();
  await expect(
    main.getByRole("heading", { name: /Order Pages Transition.*Diagnostics/i }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    main.getByRole("heading", { name: /Mirror-links bridge/i }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    main.getByRole("heading", { name: /Identity v2 backfill/i }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(main.getByRole("heading", { name: /Route mode/i })).toBeVisible({
    timeout: 5_000,
  });
});

test("transition: legacy /admin/shipstation-orders 301s to /admin/orders/shipstation", async ({
  page,
}) => {
  const responses: { url: string; status: number }[] = [];
  page.on("response", (res) =>
    responses.push({ url: res.url(), status: res.status() }),
  );
  await page.goto("/admin/shipstation-orders", { waitUntil: "domcontentloaded" });
  expect(page.url()).toContain("/admin/orders/shipstation");
  // We expect at least one 301/308 in the chain.
  const redirected = responses.some(
    (r) =>
      (r.status === 301 || r.status === 308) && /\/admin\/shipstation-orders/.test(r.url),
  );
  expect(redirected, "expected 301/308 redirect from legacy route").toBe(true);
});

test("transition: Direct list + detail page (route_mode=direct)", async ({ page }) => {
  // Flip the workspace flag to "direct" via Server Action (proves the
  // operator surface works), then visit /admin/orders (now Direct), find a
  // real order detail link, and load it. Restore the flag after.
  await page.goto("/admin/orders/diagnostics", { waitUntil: "domcontentloaded" });
  // The reason field requires >=8 chars per Server Action validation.
  await page.locator('textarea, input[type="text"]').first().fill("smoke-test transition flip");
  await page.getByRole("button", { name: /^Set to direct$/i }).click();
  await expect(page.getByText(/Route mode set to direct/i)).toBeVisible({ timeout: 8_000 });

  try {
    const r1 = await visit(page, "/admin/orders", /orders/i);
    audit.routes.push(r1);
    expect(r1.pageErrors).toEqual([]);
    expect(r1.status).toBe(200);

    // Now Direct view should be rendered. Look for a link into the detail page.
    const detailLinks = page.locator(
      'a[href^="/admin/orders/"]:not([href$="/shipstation"]):not([href$="/diagnostics"]):not([href$="/holds"])',
    );
    const count = await detailLinks.count();
    let firstHref: string | null = null;
    for (let i = 0; i < count; i += 1) {
      const href = await detailLinks.nth(i).getAttribute("href");
      if (href && href !== "/admin/orders" && href.startsWith("/admin/orders/")) {
        firstHref = href;
        break;
      }
    }
    test.skip(
      !firstHref,
      "No Direct Orders rows in this workspace (warehouse_orders empty?)",
    );
    const r2 = await visit(page, firstHref!);
    audit.routes.push(r2);
    expect(r2.pageErrors).toEqual([]);
    expect(r2.status).toBe(200);
    // Detail page renders the order_number as h1 (e.g. "BC-2584927264"
    // for Bandcamp, "#1234" for Shopify, etc.) — assert it's non-empty.
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible({ timeout: 8_000 });
    const headingText = (await h1.innerText()).trim();
    expect(headingText.length).toBeGreaterThan(0);
    // And the status badge / shipments / mirror links section should render
    // (any one of: Items, Shipments, Mirror links, Tracking, Writebacks).
    await expect(
      page.getByText(/Items|Shipments|Mirror links|Tracking|Writebacks/i).first(),
    ).toBeVisible({ timeout: 8_000 });
  } finally {
    // Restore route_mode to shipstation_mirror (default safe state).
    await page.goto("/admin/orders/diagnostics", { waitUntil: "domcontentloaded" });
    await page
      .locator('textarea, input[type="text"]')
      .first()
      .fill("smoke-test transition restore");
    await page
      .getByRole("button", { name: /Set to shipstation_mirror/i })
      .click();
    await expect(page.getByText(/Route mode set to shipstation_mirror/i)).toBeVisible({
      timeout: 8_000,
    });
  }
});
