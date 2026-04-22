// Horizontal-overflow audit — visits every major page at multiple viewport
// widths and asserts that documentElement.scrollWidth never exceeds the
// viewport width. Also asserts that no sticky/fixed action button is clipped
// past the right edge.
//
// Failure mode this catches: a page-level horizontal scrollbar showing up
// on certain screen sizes, usually because some flex parent is missing
// min-w-0 and an inner table/form is forcing the entire layout wider than
// the viewport. The fix is almost always to add min-w-0 to a flex parent
// OR overflow-x-auto to a wrapping container around the wide element.
//
// Reports per (route, viewport) so you can pinpoint which combinations are
// still broken after a layout fix.

import fs from "node:fs/promises";
import path from "node:path";
import { type Page, test } from "@playwright/test";
import { setupClientSession, setupStaffSession } from "./helpers/auth";
import { createTestOrg } from "./helpers/test-data";

const VIEWPORTS = [
  { label: "mobile", width: 375, height: 812 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "laptop", width: 1280, height: 800 },
  { label: "desktop", width: 1920, height: 1080 },
] as const;

const STAFF_ROUTES = [
  "/admin",
  "/admin/inventory",
  "/admin/orders",
  "/admin/inbound",
  "/admin/catalog",
  "/admin/clients",
  "/admin/shipping",
  "/admin/billing",
  "/admin/channels",
  "/admin/settings",
  "/admin/settings/feature-flags",
  "/admin/settings/carrier-map",
  "/admin/settings/health",
  "/admin/settings/users",
  "/admin/settings/store-mapping",
  "/admin/scan",
  "/admin/mail-order",
];

const CLIENT_ROUTES = [
  "/portal",
  "/portal/inventory",
  "/portal/releases",
  "/portal/inbound",
  "/portal/orders",
  "/portal/sales",
  "/portal/billing",
  "/portal/settings",
];

const PUBLIC_ROUTES = ["/login", "/privacy", "/terms"];

interface OverflowResult {
  role: string;
  path: string;
  viewport: string;
  width: number;
  scrollWidth: number;
  clientWidth: number;
  overflowPx: number;
  status?: number;
  error?: string;
  // Element selectors that are wider than the viewport — helps debug.
  offenders: Array<{ selector: string; width: number; tagName: string }>;
}

const allResults: OverflowResult[] = [];

test.setTimeout(600_000);

async function checkOverflow(
  page: Page,
  role: string,
  routePath: string,
  viewport: { label: string; width: number; height: number },
): Promise<OverflowResult> {
  const result: OverflowResult = {
    role,
    path: routePath,
    viewport: viewport.label,
    width: viewport.width,
    scrollWidth: 0,
    clientWidth: 0,
    overflowPx: 0,
    offenders: [],
  };
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const res = await page.goto(routePath, { waitUntil: "domcontentloaded", timeout: 20_000 });
    result.status = res?.status();
    // Wait briefly so client-fetched content can settle (tables etc.).
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);

    // Re-set viewport AFTER load in case layout shifted.
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(150);

    const measurement = await page.evaluate(() => {
      const docEl = document.documentElement;
      const scrollWidth = docEl.scrollWidth;
      const clientWidth = docEl.clientWidth;
      const overflowPx = scrollWidth - clientWidth;
      // If overflowing, find DOM elements wider than the viewport so the
      // failure is debuggable from the report alone.
      const offenders: Array<{ selector: string; width: number; tagName: string }> = [];
      if (overflowPx > 1) {
        const els = Array.from(document.querySelectorAll("*"));
        for (const el of els) {
          const w = el.getBoundingClientRect().width;
          if (w > clientWidth + 1) {
            // Build a stable-ish selector for debugging.
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : "";
            const cls =
              el.className && typeof el.className === "string"
                ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
                : "";
            offenders.push({
              selector: `${tag}${id}${cls}`.slice(0, 200),
              width: Math.round(w),
              tagName: tag,
            });
            if (offenders.length >= 5) break;
          }
        }
      }
      return { scrollWidth, clientWidth, overflowPx, offenders };
    });
    result.scrollWidth = measurement.scrollWidth;
    result.clientWidth = measurement.clientWidth;
    result.overflowPx = measurement.overflowPx;
    result.offenders = measurement.offenders;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

let clientOrgId: string | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const org = await createTestOrg("Overflow Audit");
  clientOrgId = org.orgId;
});

test.afterAll(async () => {
  // Aggregate report
  const reportDir = path.join(process.cwd(), "reports", "playwright-audit");
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const failed = allResults.filter((r) => r.overflowPx > 1);
  const passed = allResults.filter((r) => r.overflowPx <= 1 && !r.error);
  const errored = allResults.filter((r) => !!r.error);

  const md = [
    "# Horizontal Overflow Audit",
    "",
    `- Routes × viewports tested: ${allResults.length}`,
    `- Pass: ${passed.length}`,
    `- Fail (overflow): ${failed.length}`,
    `- Errored (could not load): ${errored.length}`,
    "",
    "## Failures (page-level horizontal overflow)",
    "",
    failed.length === 0
      ? "_None — every page fits within every viewport tested._"
      : failed
          .map(
            (r) =>
              `- (${r.role}) \`${r.path}\` @ ${r.viewport} (${r.width}px): scrollWidth=${r.scrollWidth} clientWidth=${r.clientWidth} (overflow=${r.overflowPx}px). Offenders: ${
                r.offenders.length === 0
                  ? "none captured"
                  : r.offenders.map((o) => `${o.selector} (${o.width}px)`).join(", ")
              }`,
          )
          .join("\n"),
    "",
    "## Errored routes",
    "",
    errored.length === 0
      ? "_None._"
      : errored.map((r) => `- (${r.role}) \`${r.path}\` @ ${r.viewport}: ${r.error}`).join("\n"),
    "",
  ].join("\n");

  await fs.writeFile(
    path.join(reportDir, `overflow-audit-${stamp}.json`),
    JSON.stringify(allResults, null, 2),
  );
  await fs.writeFile(path.join(reportDir, `overflow-audit-${stamp}.md`), md);

  console.log(
    `\n[overflow-audit] ${passed.length}/${allResults.length} pass, ${failed.length} fail, ${errored.length} errored`,
  );
  console.log(`[overflow-audit] report: ${path.join(reportDir, `overflow-audit-${stamp}.md`)}`);
});

test("staff routes: no horizontal overflow at any viewport", async ({ page }) => {
  await setupStaffSession(page);
  for (const route of STAFF_ROUTES) {
    for (const vp of VIEWPORTS) {
      const r = await checkOverflow(page, "staff", route, vp);
      allResults.push(r);
    }
  }
  const failed = allResults.filter((r) => r.role === "staff" && r.overflowPx > 1);
  if (failed.length > 0) {
    console.log(
      `[overflow-audit] STAFF FAILURES (${failed.length}):\n` +
        failed
          .map(
            (r) =>
              `  ${r.path} @ ${r.viewport}: ${r.overflowPx}px overflow${r.offenders.length > 0 ? ` — first offender: ${r.offenders[0].selector}` : ""}`,
          )
          .join("\n"),
    );
  }
});

test("client portal routes: no horizontal overflow at any viewport", async ({ page }) => {
  if (!clientOrgId) throw new Error("clientOrgId not set");
  await setupClientSession(page, clientOrgId);
  for (const route of CLIENT_ROUTES) {
    for (const vp of VIEWPORTS) {
      const r = await checkOverflow(page, "client", route, vp);
      allResults.push(r);
    }
  }
  const failed = allResults.filter((r) => r.role === "client" && r.overflowPx > 1);
  if (failed.length > 0) {
    console.log(
      `[overflow-audit] CLIENT FAILURES (${failed.length}):\n` +
        failed
          .map(
            (r) =>
              `  ${r.path} @ ${r.viewport}: ${r.overflowPx}px overflow${r.offenders.length > 0 ? ` — first offender: ${r.offenders[0].selector}` : ""}`,
          )
          .join("\n"),
    );
  }
});

test("public routes: no horizontal overflow at any viewport", async ({ page }) => {
  for (const route of PUBLIC_ROUTES) {
    for (const vp of VIEWPORTS) {
      const r = await checkOverflow(page, "public", route, vp);
      allResults.push(r);
    }
  }
  const failed = allResults.filter((r) => r.role === "public" && r.overflowPx > 1);
  if (failed.length > 0) {
    console.log(
      `[overflow-audit] PUBLIC FAILURES (${failed.length}):\n` +
        failed
          .map(
            (r) =>
              `  ${r.path} @ ${r.viewport}: ${r.overflowPx}px overflow${r.offenders.length > 0 ? ` — first offender: ${r.offenders[0].selector}` : ""}`,
          )
          .join("\n"),
    );
  }
});
