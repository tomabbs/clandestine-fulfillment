export const CACHE_TIERS = {
  REALTIME: { staleTime: 30_000, refetchInterval: 30_000 },
  SESSION: { staleTime: 5 * 60_000 },
  STABLE: { staleTime: 30 * 60_000 },
} as const;
