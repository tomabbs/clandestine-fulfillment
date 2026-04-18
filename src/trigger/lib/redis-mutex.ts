import { _getRedis } from "@/lib/clients/redis-inventory";

/**
 * Redis mutex helper for serializing per-resource external writes.
 *
 * Plan §7.1.10 (concurrency hazard 1): ShipStation v1
 * `PUT /products/{productId}` is a full-resource replacement. Two
 * concurrent rectify tasks racing on the same product cause a lost-update
 * on the `aliases[]` array — the second PUT clobbers the first's addition.
 * Solution: per-product Redis mutex acquired with `SET NX EX` before GET,
 * released after PUT-verify.
 *
 * Plan §7.1.10 Patch D1 — TTL sized for ShipStation v1 rate limiting:
 * the v1 40 req/min limit means a 429 with `Retry-After: 60` plus our
 * internal backoff can sleep longer than 30s, expiring a naive 30s mutex
 * mid-flight. We default to 120s — strictly greater than worst-case
 * `Retry-After` (60s) + GET + PUT + verify (~5s) + jitter. Future probes
 * can raise to 180s; never lower without re-running the rate-limit math.
 *
 * Safe-release: we use a Lua script that DELs only if the stored value
 * matches the lock token we put there, so a task that overran its TTL
 * cannot accidentally release a different task's lock.
 */

const DEFAULT_MUTEX_TTL_SEC = 120;

/**
 * Lua: DEL if and only if the stored value equals our token. Atomic on the
 * Redis side — prevents the "I overran my TTL, someone else holds the
 * lock now, I must not release theirs" race that a naive
 * `if (await get) await del` cannot prevent.
 */
const SAFE_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export interface MutexHandle {
  key: string;
  token: string;
  ttlSec: number;
  acquiredAt: number;
}

/**
 * Try once to acquire `key`. Returns the handle on success or null if
 * another holder is in. Caller decides whether to retry or defer.
 */
export async function tryAcquireMutex(
  key: string,
  token: string,
  ttlSec: number = DEFAULT_MUTEX_TTL_SEC,
): Promise<MutexHandle | null> {
  const redis = _getRedis();
  const result = await redis.set(key, token, { nx: true, ex: ttlSec });
  if (result !== "OK") return null;
  return { key, token, ttlSec, acquiredAt: Date.now() };
}

export interface AcquireWithRetryOptions {
  /** Total time to keep retrying before giving up. Default 30s. */
  maxWaitMs?: number;
  /** Initial backoff between retries. Default 250ms. */
  initialBackoffMs?: number;
  /** Cap on per-retry backoff. Default 2000ms. */
  maxBackoffMs?: number;
}

/**
 * Acquire with bounded exponential backoff. Returns null if `maxWaitMs`
 * elapses without acquiring. Use this from Trigger tasks that can either
 * defer-and-retry or fail-fast based on the return value.
 */
export async function acquireMutex(
  key: string,
  token: string,
  ttlSec: number = DEFAULT_MUTEX_TTL_SEC,
  options: AcquireWithRetryOptions = {},
): Promise<MutexHandle | null> {
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const initialBackoffMs = options.initialBackoffMs ?? 250;
  const maxBackoffMs = options.maxBackoffMs ?? 2_000;

  const deadline = Date.now() + maxWaitMs;
  let backoff = initialBackoffMs;

  // First attempt is unconditional so the fast path skips a sleep.
  const first = await tryAcquireMutex(key, token, ttlSec);
  if (first) return first;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, backoff));
    const handle = await tryAcquireMutex(key, token, ttlSec);
    if (handle) return handle;
    backoff = Math.min(maxBackoffMs, Math.floor(backoff * 1.6));
  }
  return null;
}

/**
 * Release a held mutex. Safe to call multiple times — only the holder of
 * the matching token actually triggers a DEL.
 */
export async function releaseMutex(handle: MutexHandle): Promise<boolean> {
  const redis = _getRedis();
  const result = (await redis.eval(SAFE_RELEASE_LUA, [handle.key], [handle.token])) as number;
  return result === 1;
}

/**
 * Try-with-finally wrapper. Caller-supplied `fn` runs only if acquire
 * succeeds; release fires even on throw. Returns null when the mutex
 * could not be acquired within `options.maxWaitMs`.
 */
export async function withMutex<T>(
  key: string,
  token: string,
  fn: (handle: MutexHandle) => Promise<T>,
  options: AcquireWithRetryOptions & { ttlSec?: number } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const handle = await acquireMutex(key, token, options.ttlSec ?? DEFAULT_MUTEX_TTL_SEC, options);
  if (!handle) return { acquired: false };
  try {
    const value = await fn(handle);
    return { acquired: true, value };
  } finally {
    await releaseMutex(handle);
  }
}

// Exported for tests
export { DEFAULT_MUTEX_TTL_SEC, SAFE_RELEASE_LUA };
