// Phase 0.8 — "stores" key removed. Store connections are now administered
// through ShipStation Inventory Sync. Staff use /admin/settings/client-store-reconnect
// to per-row reactivate first-party connectors when needed.
export const TOGGLEABLE_PAGES = [
  { key: "inventory", title: "Inventory", href: "/portal/inventory" },
  { key: "catalog", title: "Catalog", href: "/portal/catalog" },
  { key: "inbound", title: "Inbound", href: "/portal/inbound" },
  { key: "fulfillment", title: "Fulfillment", href: "/portal/fulfillment" },
  { key: "mail-order", title: "Mail-Order", href: "/portal/mail-order" },
  { key: "shipping", title: "Shipping", href: "/portal/shipping" },
  { key: "sales", title: "Sales", href: "/portal/sales" },
  { key: "billing", title: "Billing", href: "/portal/billing" },
  { key: "support", title: "Support", href: "/portal/support" },
  // Phase 6 Slice 6.F — client-facing stock-exceptions feed. Visible by
  // default (following the TOGGLEABLE_PAGES convention) but separately
  // gated per-workspace by `client_stock_exception_reports_enabled` so
  // ops can enable the workspace flag before any client sees the route.
  { key: "stock-exceptions", title: "Stock Exceptions", href: "/portal/stock-exceptions" },
] as const;

export type PortalPageKey = (typeof TOGGLEABLE_PAGES)[number]["key"];

export type VisiblePages = Partial<Record<PortalPageKey, boolean>>;

/**
 * Check if a portal page is visible for a client.
 * Missing keys default to true (backward-compatible).
 */
export function isPageVisible(
  visiblePages: VisiblePages | undefined | null,
  key: PortalPageKey,
): boolean {
  if (!visiblePages) return true;
  return visiblePages[key] !== false;
}

/**
 * Resolve the page key for a given portal pathname.
 * Returns null for non-toggleable pages (Home, Settings).
 */
export function getPageKeyFromPathname(pathname: string): PortalPageKey | null {
  const entry = TOGGLEABLE_PAGES.find(
    (p) => pathname === p.href || pathname.startsWith(`${p.href}/`),
  );
  return entry?.key ?? null;
}
