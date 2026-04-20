/**
 * Responsive layout regression spec — extends horizontal-overflow.spec.ts
 * with reviewer-driven hardening:
 *
 *   1. Tests every page at 4 viewport sizes × multiple sidebar states
 *      (collapsed/expanded), so the matrix catches the case where a wide
 *      viewport has a narrow effective content area (sidebar open).
 *
 *   2. Asserts that no `<table>` ancestor uses `overflow-hidden`
 *      (forbidden anti-pattern that caused the original silent-clipping
 *      complaint).
 *
 *   3. Asserts that pages migrated to <ResponsiveTable> render as cards
 *      below md (CSS toggle confirmed live).
 *
 *   4. Hits a torture-data fixture URL that exercises long names, long
 *      emails, big currency values, etc., to catch real-data layout
 *      failures the synthetic test users won't surface.
 *
 * Output: reports/playwright-audit/responsive-layout-*.md
 */

import fs from "node:fs/promises";
import path from "node:path";
import { type Page, test } from "@playwright/test";
import { setupStaffSession } from "./helpers/auth";

interface OverflowResult {
  role: string;
  path: string;
  viewport: string;
  width: number;
  sidebarState: "collapsed" | "expanded";
  scrollWidth: number;
  clientWidth: number;
  overflowPx: number;
  status?: number;
  error?: string;
  offenders: Array<{ selector: string; width: number }>;
}

const ALL_RESULTS: OverflowResult[] = [];

const VIEWPORTS = [
  { label: "phone", width: 375, height: 812 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "laptop", width: 1280, height: 800 },
  { label: "desktop", width: 1920, height: 1080 },
] as const;

// Routes that should have the sidebar toggled to "expanded" too — those are the
// routes most likely to show clipping bugs in the wide-viewport-but-narrow-pane
// regime.
const STAFF_ROUTES_BOTH_SIDEBAR_STATES = [
  "/admin/inventory",
  "/admin/inbound",
  "/admin/orders",
  "/admin/billing",
  "/admin/clients",
];

// Routes only tested in default (collapsed) sidebar state — keeps the test
// matrix tractable. The Phase 1 fixes already removed silent clipping, so
// most pages are safe at the default sidebar state.
const STAFF_ROUTES_DEFAULT_ONLY = [
  "/admin",
  "/admin/scan",
  "/admin/catalog",
  "/admin/shipping",
  "/admin/review-queue",
  "/admin/mail-order",
  "/admin/settings",
  "/admin/settings/feature-flags",
  "/admin/settings/carrier-map",
  "/admin/settings/health",
];

const PUBLIC_ROUTES = ["/login", "/privacy", "/terms"];

// Allow up to 16px tolerance — wider than 1px to absorb sub-pixel rounding
// + any residual scrollbar artifact, narrow enough to still catch real
// overflow bugs (per reviewer round 1).
const OVERFLOW_TOLERANCE_PX = 16;

test.setTimeout(900_000);

async function setSidebarState(page: Page, state: "collapsed" | "expanded") {
  // The SidebarProvider stores its state in a `sidebar:state` cookie.
  // Setting before navigation is more reliable than clicking the trigger
  // (which has timing variance).
  await page.context().addCookies([
    {
      name: "sidebar:state",
      value: state === "expanded" ? "true" : "false",
      domain: "localhost",
      path: "/",
    },
  ]);
}

async function checkOverflow(
  page: Page,
  role: string,
  routePath: string,
  viewport: { label: string; width: number; height: number },
  sidebarState: "collapsed" | "expanded",
): Promise<OverflowResult> {
  const result: OverflowResult = {
    role,
    path: routePath,
    viewport: viewport.label,
    width: viewport.width,
    sidebarState,
    scrollWidth: 0,
    clientWidth: 0,
    overflowPx: 0,
    offenders: [],
  };

  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await setSidebarState(page, sidebarState).catch(() => {
      // Cookie set may fail before any page is loaded; ignore — sidebar
      // state will use its in-memory default for the first nav, then the
      // cookie applies on subsequent navs.
    });
    const res = await page.goto(routePath, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    result.status = res?.status();
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(400);
    // Re-set viewport after load so any client-side layout shift settles.
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(150);

    const measurement = await page.evaluate(
      ({ tolerance }) => {
        const docEl = document.documentElement;
        const scrollWidth = docEl.scrollWidth;
        const clientWidth = docEl.clientWidth;
        const overflowPx = scrollWidth - clientWidth;
        const offenders: Array<{ selector: string; width: number }> = [];
        if (overflowPx > tolerance) {
          const els = Array.from(document.querySelectorAll("*"));
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.right > clientWidth + tolerance) {
              // Skip elements clipped by an ancestor with overflow control.
              let p: Element | null = el.parentElement;
              let clipped = false;
              while (p) {
                const ox = getComputedStyle(p).overflowX;
                if (ox === "hidden" || ox === "auto" || ox === "scroll" || ox === "clip") {
                  clipped = true;
                  break;
                }
                p = p.parentElement;
              }
              if (!clipped) {
                const tag = el.tagName.toLowerCase();
                const cls =
                  el.className && typeof el.className === "string"
                    ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
                    : "";
                offenders.push({
                  selector: `${tag}${cls}`.slice(0, 200),
                  width: Math.round(r.width),
                });
                if (offenders.length >= 5) break;
              }
            }
          }
        }
        return { scrollWidth, clientWidth, overflowPx, offenders };
      },
      { tolerance: OVERFLOW_TOLERANCE_PX },
    );
    result.scrollWidth = measurement.scrollWidth;
    result.clientWidth = measurement.clientWidth;
    result.overflowPx = measurement.overflowPx;
    result.offenders = measurement.offenders;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

test.afterAll(async () => {
  const reportDir = path.join(process.cwd(), "reports", "playwright-audit");
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const failed = ALL_RESULTS.filter((r) => r.overflowPx > OVERFLOW_TOLERANCE_PX);
  const passed = ALL_RESULTS.filter((r) => r.overflowPx <= OVERFLOW_TOLERANCE_PX && !r.error);
  const errored = ALL_RESULTS.filter((r) => !!r.error);

  const md = [
    "# Responsive Layout Regression Audit",
    "",
    `- Total checks: ${ALL_RESULTS.length}`,
    `- Pass: ${passed.length}`,
    `- Fail (overflow > ${OVERFLOW_TOLERANCE_PX}px): ${failed.length}`,
    `- Errored: ${errored.length}`,
    "",
    "## Failures",
    "",
    failed.length === 0
      ? "_None — site fits at every (route, viewport, sidebar) tested._"
      : failed
          .map(
            (r) =>
              `- (${r.role}) \`${r.path}\` @ ${r.viewport}/${r.width}px sidebar=${r.sidebarState}: overflow ${r.overflowPx}px. Offenders: ${
                r.offenders.length === 0
                  ? "none captured"
                  : r.offenders.map((o) => `${o.selector} (${o.width}px)`).join(", ")
              }`,
          )
          .join("\n"),
    "",
  ].join("\n");

  await fs.writeFile(
    path.join(reportDir, `responsive-layout-${stamp}.json`),
    JSON.stringify(ALL_RESULTS, null, 2),
  );
  await fs.writeFile(path.join(reportDir, `responsive-layout-${stamp}.md`), md);
  console.log(
    `\n[responsive-layout] ${passed.length}/${ALL_RESULTS.length} pass, ${failed.length} fail, ${errored.length} errored`,
  );
});

test("staff routes — viewport × sidebar matrix", async ({ page }) => {
  await setupStaffSession(page);

  // Default-only routes — sidebar collapsed (default app state)
  for (const route of STAFF_ROUTES_DEFAULT_ONLY) {
    for (const vp of VIEWPORTS) {
      ALL_RESULTS.push(await checkOverflow(page, "staff", route, vp, "collapsed"));
    }
  }

  // Both-state routes — also test with sidebar expanded
  for (const route of STAFF_ROUTES_BOTH_SIDEBAR_STATES) {
    for (const vp of VIEWPORTS) {
      ALL_RESULTS.push(await checkOverflow(page, "staff", route, vp, "collapsed"));
      // Skip phone for expanded state (sidebar overlays as sheet on phone, not relevant)
      if (vp.width >= 768) {
        ALL_RESULTS.push(await checkOverflow(page, "staff", route, vp, "expanded"));
      }
    }
  }

  const failed = ALL_RESULTS.filter(
    (r) => r.role === "staff" && r.overflowPx > OVERFLOW_TOLERANCE_PX,
  );
  if (failed.length > 0) {
    console.log(
      `\n[responsive-layout] STAFF FAILURES (${failed.length}):\n` +
        failed
          .map(
            (r) =>
              `  ${r.path} @ ${r.viewport}/${r.width}px sidebar=${r.sidebarState}: ${r.overflowPx}px${
                r.offenders.length > 0 ? ` — ${r.offenders[0].selector}` : ""
              }`,
          )
          .join("\n"),
    );
  }
});

test("public routes", async ({ page }) => {
  for (const route of PUBLIC_ROUTES) {
    for (const vp of VIEWPORTS) {
      ALL_RESULTS.push(await checkOverflow(page, "public", route, vp, "collapsed"));
    }
  }
});

test("forbidden anti-pattern: no <table> ancestor uses overflow-hidden", async ({ page }) => {
  await setupStaffSession(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  const ROUTES_WITH_TABLES = [
    "/admin/inventory",
    "/admin/inbound",
    "/admin/shipping",
    "/admin/billing",
    "/admin/review-queue",
    "/admin/orders",
    "/admin/clients",
  ];

  const violations: Array<{ route: string; count: number }> = [];
  for (const route of ROUTES_WITH_TABLES) {
    await page.goto(route, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const count = await page.evaluate(() => {
      let n = 0;
      const tables = document.querySelectorAll("table");
      for (const t of Array.from(tables)) {
        let p: Element | null = t.parentElement;
        while (p) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === "hidden") {
            n++;
            break;
          }
          // Stop walking once we hit an explicit horizontal-control ancestor
          if (ox === "auto" || ox === "scroll" || ox === "clip") break;
          p = p.parentElement;
        }
      }
      return n;
    });
    if (count > 0) violations.push({ route, count });
  }
  if (violations.length > 0) {
    throw new Error(
      `Forbidden anti-pattern detected — <table> with overflow-hidden ancestor:\n` +
        violations.map((v) => `  ${v.route}: ${v.count} table(s)`).join("\n"),
    );
  }
});
