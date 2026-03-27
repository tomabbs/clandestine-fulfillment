/**
 * Redis-backed rate limiter for Discogs API.
 *
 * CRITICAL: In-memory rate limiting DOES NOT WORK in serverless environments.
 * Each lambda/worker instance has its own memory, so they can't coordinate.
 * This uses Redis (Upstash) for distributed rate limiting across all instances.
 *
 * Uses sliding window algorithm via Redis sorted set.
 */

import { Redis } from "@upstash/redis";
import { env } from "@/lib/shared/env";

const RATE_LIMIT_KEY = "discogs:rate_limit:requests";
const REQUESTS_PER_MINUTE = 60;
const WINDOW_SECONDS = 60;

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = env();
    _redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  }
  return _redis;
}

/**
 * Check if we can make a Discogs API request.
 * Uses Redis sorted set as a sliding window counter.
 * Records this request in the window if allowed.
 */
export async function checkDiscogsRateLimit(): Promise<{
  allowed: boolean;
  remaining: number;
  waitMs: number;
}> {
  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * 1000;

  // Remove old entries outside the window
  await redis.zremrangebyscore(RATE_LIMIT_KEY, 0, windowStart);

  // Count requests in current window
  const count = await redis.zcard(RATE_LIMIT_KEY);
  const remaining = Math.max(0, REQUESTS_PER_MINUTE - count);

  if (count >= REQUESTS_PER_MINUTE) {
    // Get oldest entry to calculate wait time
    const oldest = await redis.zrange<string[]>(RATE_LIMIT_KEY, 0, 0, { withScores: true });
    const oldestScore = oldest.length > 1 ? Number(oldest[1]) : now;
    const waitMs = Math.max(0, oldestScore + WINDOW_SECONDS * 1000 - now + 100);

    return { allowed: false, remaining: 0, waitMs };
  }

  // Record this request in the window
  const requestId = `${now}:${Math.random().toString(36).slice(2)}`;
  await redis.zadd(RATE_LIMIT_KEY, { score: now, member: requestId });

  // Auto-cleanup TTL (slightly longer than window)
  await redis.expire(RATE_LIMIT_KEY, WINDOW_SECONDS + 10);

  return { allowed: true, remaining: remaining - 1, waitMs: 0 };
}

/**
 * Wait until rate limit allows a request, then proceed.
 * Call this before every Discogs API call.
 */
export async function waitForDiscogsRateLimit(): Promise<void> {
  const maxRetries = 5;
  let retries = 0;

  while (retries < maxRetries) {
    const { allowed, waitMs, remaining } = await checkDiscogsRateLimit();

    if (allowed) {
      console.log(`[discogs-rate-limit] Request allowed, ${remaining} remaining`);
      return;
    }

    console.log(
      `[discogs-rate-limit] Rate limited, waiting ${waitMs}ms (retry ${retries + 1}/${maxRetries})`,
    );

    // Jitter to avoid thundering herd across concurrent serverless invocations
    const jitter = Math.random() * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));

    retries++;
  }

  throw new Error("Discogs rate limit exceeded after max retries");
}

/**
 * Get current rate limit status for monitoring / debugging.
 */
export async function getDiscogsRateLimitStatus(): Promise<{
  used: number;
  remaining: number;
  resetsInMs: number;
}> {
  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * 1000;

  await redis.zremrangebyscore(RATE_LIMIT_KEY, 0, windowStart);
  const count = await redis.zcard(RATE_LIMIT_KEY);

  const oldest = await redis.zrange<string[]>(RATE_LIMIT_KEY, 0, 0, { withScores: true });
  const oldestScore = oldest.length > 1 ? Number(oldest[1]) : now;
  const resetsInMs = Math.max(0, oldestScore + WINDOW_SECONDS * 1000 - now);

  return {
    used: count,
    remaining: Math.max(0, REQUESTS_PER_MINUTE - count),
    resetsInMs,
  };
}
