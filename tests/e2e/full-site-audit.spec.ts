import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { setupClientSession, setupStaffSession } from "./helpers/auth";
import { cleanupTestData, createTestOrg } from "./helpers/test-data";

type ConsoleIssue = {
  type: string;
  text: string;
  location?: string;
};

type NetworkIssue = {
  kind: "requestfailed" | "http_error";
  method: string;
  status?: number;
  url: string;
  resourceType?: string;
  errorText?: string;
};

type RouteAudit = {
  role: "staff" | "client" | "public";
  path: string;
  ok: boolean;
  skipped?: boolean;
  note?: string;
  headingCheck?: string;
  status?: number;
  error?: string;
  hasErrorBoundary: boolean;
  consoleIssues: ConsoleIssue[];
  pageErrors: string[];
  networkIssues: NetworkIssue[];
  loadTimeMs?: number;
  hydrationMismatches: number;
};

type AuditRun = {
  startedAt: string;
  finishedAt?: string;
  baseUrl: string;
  routes: RouteAudit[];
};

const auditRun: AuditRun = {
  startedAt: new Date().toISOString(),
  baseUrl: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  routes: [],
};

test.setTimeout(240_000);

const STAFF_ROUTES: Array<{ path: string; heading: RegExp }> = [
  { path: "/admin", heading: /dashboard/i },
  { path: "/admin/inventory", heading: /inventory/i },
  { path: "/admin/inbound", heading: /inbound/i },
  { path: "/admin/orders", heading: /orders/i },
  { path: "/admin/catalog", heading: /catalog/i },
  { path: "/admin/clients", heading: /clients/i },
  { path: "/admin/shipping", heading: /shipping/i },
  { path: "/admin/shipping/pirate-ship", heading: /pirate ship|shipping/i },
  { path: "/admin/billing", heading: /billing/i },
  { path: "/admin/channels", heading: /channels/i },
  { path: "/admin/review-queue", heading: /review queue|review q/i },
  { path: "/admin/support", heading: /support/i },
  { path: "/admin/scan", heading: /scan/i },
  { path: "/admin/settings", heading: /settings/i },
  { path: "/admin/settings/users", heading: /user management|users/i },
  { path: "/admin/settings/bandcamp", heading: /bandcamp/i },
  { path: "/admin/settings/store-connections", heading: /store connections/i },
  { path: "/admin/settings/store-mapping", heading: /store mapping/i },
  { path: "/admin/settings/integrations", heading: /integrations/i },
  { path: "/admin/settings/health", heading: /health/i },
  { path: "/admin/reports/top-sellers", heading: /top sellers/i },
  { path: "/admin/mail-order", heading: /mail.?order/i },
  { path: "/admin/shipstation-orders", heading: /shipstation|orders/i },
  { path: "/admin/discogs", heading: /discogs/i },
  { path: "/admin/discogs/credentials", heading: /discogs|credentials/i },
  { path: "/admin/discogs/matching", heading: /discogs|matching/i },
];

const CLIENT_ROUTES: Array<{ path: string; heading: RegExp }> = [
  { path: "/portal", heading: /welcome|dashboard/i },
  { path: "/portal/inventory", heading: /inventory/i },
  { path: "/portal/releases", heading: /catalog/i },
  { path: "/portal/inbound", heading: /inbound/i },
  { path: "/portal/inbound/new", heading: /inbound/i },
  { path: "/portal/orders", heading: /fulfillment/i },
  { path: "/portal/shipping", heading: /shipping/i },
  { path: "/portal/sales", heading: /sales/i },
  { path: "/portal/billing", heading: /billing/i },
  { path: "/portal/support", heading: /support/i },
  { path: "/portal/settings", heading: /settings/i },
  { path: "/portal/catalog", heading: /catalog/i },
  { path: "/portal/fulfillment", heading: /fulfillment|shipping/i },
  { path: "/portal/mail-order", heading: /mail.?order/i },
  { path: "/portal/stores", heading: /store|connect/i },
];

const PUBLIC_ROUTES: Array<{ path: string; heading?: RegExp }> = [
  { path: "/login" },
  { path: "/privacy" },
  { path: "/terms" },
];

async function auditRoute(
  page: Page,
  role: RouteAudit["role"],
  targetPath: string,
  heading?: RegExp,
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
      consoleIssues.push({
        type,
        text: msg.text(),
        location: msg.location()?.url,
      });
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
  let routeError: string | undefined;
  let headingCheck = "not_checked";
  let hasErrorBoundary = false;
  const loadStart = Date.now();
  let loadTimeMs: number | undefined;
  try {
    const res = await page.goto(targetPath, { waitUntil: "domcontentloaded", timeout: 15_000 });
    loadTimeMs = Date.now() - loadStart;
    status = res?.status();

    if (heading) {
      await expect(page.locator("h1").first()).toContainText(heading, { timeout: 10_000 });
      headingCheck = "passed";
    }

    const errorBoundaryCount = await page.locator("[data-nextjs-error]").count();
    hasErrorBoundary = errorBoundaryCount > 0;
  } catch (error) {
    routeError = error instanceof Error ? error.message : String(error);
    if (heading) headingCheck = "failed";
  } finally {
    page.off("console", onConsole as never);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed as never);
    page.off("response", onResponse as never);
  }

  const hasServerNetworkError = networkIssues.some(
    (issue) => issue.kind === "http_error" && (issue.status ?? 0) >= 500,
  );

  const hydrationMismatches = consoleIssues.filter(
    (i) => i.type === "error" && /hydrat/i.test(i.text),
  ).length;

  return {
    role,
    path: targetPath,
    ok: !routeError && !hasErrorBoundary && pageErrors.length === 0 && !hasServerNetworkError,
    headingCheck,
    status,
    error: routeError,
    hasErrorBoundary,
    consoleIssues,
    pageErrors,
    networkIssues,
    loadTimeMs,
    hydrationMismatches,
  };
}

async function findFirstDetailLink(page: Page, prefix: string): Promise<string | null> {
  const links = page.locator(`a[href^="${prefix}"]`);
  const count = await links.count();
  for (let i = 0; i < count; i += 1) {
    const href = await links.nth(i).getAttribute("href");
    if (href && href !== prefix) return href;
  }
  return null;
}

let clientOrgId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const org = await createTestOrg("Full Site Audit");
  clientOrgId = org.orgId;
});

test.afterAll(async () => {
  auditRun.finishedAt = new Date().toISOString();
  const reportDir = path.join(process.cwd(), "reports", "playwright-audit");
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(reportDir, `full-site-audit-${stamp}.json`);
  const mdPath = path.join(reportDir, `full-site-audit-${stamp}.md`);

  const total = auditRun.routes.length;
  const passed = auditRun.routes.filter((r) => r.ok).length;
  const failed = auditRun.routes.filter((r) => !r.ok && !r.skipped).length;
  const skipped = auditRun.routes.filter((r) => r.skipped).length;
  const totalConsole = auditRun.routes.reduce((n, r) => n + r.consoleIssues.length, 0);
  const totalPageErrors = auditRun.routes.reduce((n, r) => n + r.pageErrors.length, 0);
  const totalNetwork = auditRun.routes.reduce((n, r) => n + r.networkIssues.length, 0);

  const md = [
    "# Full Site Playwright Audit",
    "",
    `- Started: ${auditRun.startedAt}`,
    `- Finished: ${auditRun.finishedAt}`,
    `- Base URL: ${auditRun.baseUrl}`,
    `- Routes audited: ${total}`,
    `- Passed: ${passed}`,
    `- Failed: ${failed}`,
    `- Skipped: ${skipped}`,
    `- Console warnings/errors captured: ${totalConsole}`,
    `- Page errors captured: ${totalPageErrors}`,
    `- Network issues captured: ${totalNetwork}`,
    "",
    "## Route Results",
    "",
    ...auditRun.routes.map((r) => {
      const status = r.skipped ? "SKIPPED" : r.ok ? "PASS" : "FAIL";
      const timing = r.loadTimeMs != null ? ` load=${r.loadTimeMs}ms` : "";
      const hydration = r.hydrationMismatches > 0 ? ` hydration=${r.hydrationMismatches}` : "";
      const slow = (r.loadTimeMs ?? 0) > 5000 ? " [SLOW]" : "";
      return `- [${status}] (${r.role}) \`${r.path}\` status=${r.status ?? "n/a"} console=${r.consoleIssues.length} pageErrors=${r.pageErrors.length} network=${r.networkIssues.length}${timing}${hydration}${slow}${r.note ? ` note=${r.note}` : ""}${r.error ? ` error=${r.error}` : ""}`;
    }),
    "",
  ].join("\n");

  await fs.writeFile(jsonPath, JSON.stringify(auditRun, null, 2), "utf8");
  await fs.writeFile(mdPath, md, "utf8");
  await cleanupTestData();
});

test("staff full-site page audit", async ({ page }) => {
  await setupStaffSession(page);
  for (const route of STAFF_ROUTES) {
    const result = await auditRoute(page, "staff", route.path, route.heading);
    auditRun.routes.push(result);
  }

  // Attempt dynamic detail pages if discoverable from list pages.
  await page.goto("/admin/clients");
  const clientDetail = await findFirstDetailLink(page, "/admin/clients/");
  auditRun.routes.push(
    clientDetail
      ? await auditRoute(page, "staff", clientDetail)
      : {
          role: "staff",
          path: "/admin/clients/[id]",
          ok: true,
          skipped: true,
          note: "No detail links found in clients list",
          hasErrorBoundary: false,
          consoleIssues: [],
          pageErrors: [],
          networkIssues: [],
          hydrationMismatches: 0,
        },
  );

  await page.goto("/admin/catalog");
  const catalogDetail = await findFirstDetailLink(page, "/admin/catalog/");
  auditRun.routes.push(
    catalogDetail
      ? await auditRoute(page, "staff", catalogDetail)
      : {
          role: "staff",
          path: "/admin/catalog/[id]",
          ok: true,
          skipped: true,
          note: "No detail links found in catalog list",
          hasErrorBoundary: false,
          consoleIssues: [],
          pageErrors: [],
          networkIssues: [],
          hydrationMismatches: 0,
        },
  );

  await page.goto("/admin/inbound");
  const inboundDetail = await findFirstDetailLink(page, "/admin/inbound/");
  auditRun.routes.push(
    inboundDetail
      ? await auditRoute(page, "staff", inboundDetail)
      : {
          role: "staff",
          path: "/admin/inbound/[id]",
          ok: true,
          skipped: true,
          note: "No detail links found in inbound list",
          hasErrorBoundary: false,
          consoleIssues: [],
          pageErrors: [],
          networkIssues: [],
          hydrationMismatches: 0,
        },
  );
});

test("client full-site page audit", async ({ page }) => {
  await setupClientSession(page, clientOrgId);
  for (const route of CLIENT_ROUTES) {
    const result = await auditRoute(page, "client", route.path, route.heading);
    auditRun.routes.push(result);
  }
});

test("public routes audit", async ({ page }) => {
  for (const route of PUBLIC_ROUTES) {
    const result = await auditRoute(page, "public", route.path, route.heading);
    auditRun.routes.push(result);
  }
});
