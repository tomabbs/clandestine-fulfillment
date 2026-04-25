import { ShieldAlert } from "lucide-react";
import {
  getSkuMatchingWorkspace,
  listSkuMatchingClients,
  listSkuMatchingConnections,
} from "@/actions/sku-matching";
import { SkuMatchingClient } from "./sku-matching-client";

export default async function SkuMatchingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const params = (await searchParams) ?? {};
    const orgId = typeof params.orgId === "string" ? params.orgId : undefined;
    const requestedConnectionId =
      typeof params.connectionId === "string" ? params.connectionId : undefined;

    const [clients, connections] = await Promise.all([
      listSkuMatchingClients(),
      listSkuMatchingConnections({ orgId }),
    ]);

    if (connections.length === 0) {
      return (
        <div className="p-6">
          <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
            No Shopify, WooCommerce, or Squarespace connections are available for SKU matching yet.
          </div>
        </div>
      );
    }

    const activeConnectionId =
      requestedConnectionId &&
      connections.some((connection) => connection.id === requestedConnectionId)
        ? requestedConnectionId
        : connections[0].id;

    const workspace = await getSkuMatchingWorkspace({ connectionId: activeConnectionId });

    return (
      <SkuMatchingClient
        clients={clients}
        connections={connections}
        workspace={workspace}
        selectedOrgId={orgId ?? null}
      />
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-2 text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Failed to load SKU matching.</p>
              <p className="mt-1 break-words text-destructive/90">{message}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
