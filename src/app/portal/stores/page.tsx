/**
 * Phase 0.8 — Portal "Connected Stores" page is dormant.
 *
 * The legacy multi-platform connector UI is hidden because ShipStation
 * Inventory Sync is now the canonical fanout path. The route remains so
 * that bookmarks render a clear explanation rather than a 404, but the
 * middleware (middleware.ts) ALSO redirects /portal/stores → /portal so
 * the user never lands here from in-app navigation. This page is the
 * fallback for direct-link visits.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function PortalStoresDormantPage() {
  return (
    <div className="p-6 space-y-4 max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Connected Stores</h1>
      <Card>
        <CardHeader>
          <CardTitle>Store connections are managed by Clandestine</CardTitle>
          <CardDescription>
            Inventory and orders for your Shopify, WooCommerce, and Squarespace stores now flow
            through ShipStation Inventory Sync, configured by our staff. You no longer need to
            connect store credentials in the portal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Need a change to how your stores are wired up? Reach out via the{" "}
            <a href="/portal/support" className="underline">
              Support
            </a>{" "}
            page.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
