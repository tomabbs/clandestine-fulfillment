import { ShieldAlert } from "lucide-react";
import { getStoreConnectionOrganizations, getStoreConnections } from "@/actions/store-connections";
import { StoreConnectionsClient } from "./store-connections-client";

export default async function StoreConnectionsPage() {
  try {
    const [{ connections }, organizations] = await Promise.all([
      getStoreConnections(),
      getStoreConnectionOrganizations(),
    ]);

    return (
      <StoreConnectionsClient initialConnections={connections} organizations={organizations} />
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-2 text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Failed to load store connections.</p>
              <p className="mt-1 break-words text-destructive/90">{message}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
