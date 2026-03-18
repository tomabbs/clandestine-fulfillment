export const CACHE_TIERS = {
  /** Dashboard, sync status, inventory — refresh frequently */
  REALTIME: { staleTime: 30_000, gcTime: 5 * 60_000 },
  /** Products, shipments, orders, clients — moderate refresh */
  SESSION: { staleTime: 5 * 60_000, gcTime: 30 * 60_000 },
  /** Billing rules, store mappings, format costs — rarely changes */
  STABLE: { staleTime: 30 * 60_000, gcTime: 2 * 60 * 60_000 },
} as const;
