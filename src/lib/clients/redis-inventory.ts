import { Redis } from "@upstash/redis";
import { env } from "@/lib/shared/env";

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis) return _redis;
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = env();
  _redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });
  return _redis;
}

export interface InventoryLevels {
  available: number;
  committed: number;
  incoming: number;
}

/**
 * Get inventory levels for a SKU from Redis.
 */
export async function getInventory(sku: string): Promise<InventoryLevels> {
  const redis = getRedis();
  const data = await redis.hgetall<Record<string, string>>(`inv:${sku}`);
  return {
    available: Number(data?.available ?? 0),
    committed: Number(data?.committed ?? 0),
    incoming: Number(data?.incoming ?? 0),
  };
}

/**
 * Set inventory fields for a SKU in Redis.
 */
export async function setInventory(sku: string, fields: Partial<InventoryLevels>): Promise<void> {
  const redis = getRedis();
  const mapped: Record<string, number> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) mapped[key] = val;
  }
  if (Object.keys(mapped).length > 0) {
    await redis.hset(`inv:${sku}`, mapped);
  }
}

/**
 * Rule #47: Atomic Lua script — SETNX idempotency check + HINCRBY in one call.
 * Returns the new value after HINCRBY, or null if the idempotency key already existed.
 */
const ADJUST_LUA_SCRIPT = `
if redis.call('SETNX', KEYS[1], 1) == 1 then
  redis.call('EXPIRE', KEYS[1], 86400)
  return redis.call('HINCRBY', KEYS[2], ARGV[1], ARGV[2])
else
  return nil
end
`;

export async function adjustInventory(
  sku: string,
  field: keyof InventoryLevels,
  delta: number,
  idempotencyKey: string,
): Promise<number | null> {
  const redis = getRedis();
  const result = await redis.eval(
    ADJUST_LUA_SCRIPT,
    [`processed:${idempotencyKey}`, `inv:${sku}`],
    [field, delta],
  );
  return result as number | null;
}

/**
 * Rule #59: Bulk set inventory for sync operations via Redis pipeline.
 * Only for shopify-sync and shopify-full-backfill tasks.
 */
export async function bulkSetInventory(
  entries: Array<{ sku: string; levels: Partial<InventoryLevels> }>,
): Promise<void> {
  const redis = getRedis();
  const pipeline = redis.pipeline();
  for (const entry of entries) {
    const mapped: Record<string, number> = {};
    for (const [key, val] of Object.entries(entry.levels)) {
      if (val !== undefined) mapped[key] = val;
    }
    if (Object.keys(mapped).length > 0) {
      pipeline.hset(`inv:${entry.sku}`, mapped);
    }
  }
  await pipeline.exec();
}

// Export for testing
export { ADJUST_LUA_SCRIPT as _ADJUST_LUA_SCRIPT, getRedis as _getRedis };
