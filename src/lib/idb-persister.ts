import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";

const IDB_KEY = "clandestine-react-query-cache";

/**
 * Creates an IndexedDB-backed React Query persister.
 * All operations are wrapped in try/catch so that if IDB is unavailable or
 * corrupted (e.g. after clearing browser history), the app falls back to
 * in-memory-only mode instead of breaking all data fetching.
 */
export function createIDBPersister(): Persister {
  return {
    persistClient: async (client: PersistedClient) => {
      try {
        await set(IDB_KEY, client);
      } catch {
        // IDB unavailable — continue without persistence
      }
    },
    restoreClient: async () => {
      try {
        return await get<PersistedClient>(IDB_KEY);
      } catch {
        return undefined;
      }
    },
    removeClient: async () => {
      try {
        await del(IDB_KEY);
      } catch {
        // IDB unavailable — nothing to remove
      }
    },
  };
}
