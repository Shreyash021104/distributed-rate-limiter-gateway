import { Redis } from "ioredis";
import { env } from "./env.js";

// The client options below are the difference between fail-open working and
// only appearing to work.
//
// `rateLimitMiddleware` catches limiter errors and lets the request through,
// on the reasoning that a briefly-too-permissive limiter beats a gateway
// that 500s its entire upstream over a Redis hiccup. But with ioredis's
// defaults that catch block barely runs: `enableOfflineQueue` (default true)
// parks commands in an in-memory queue while disconnected instead of
// rejecting them, and `maxRetriesPerRequest` (default 20) keeps them parked
// across twenty reconnect attempts. Measured against a dead Redis with the
// defaults, individual requests took 2.5s, 7.1s, and one still hadn't
// returned after 30 seconds. Every one of those eventually "failed open" —
// which is worthless, because a gateway adding seconds of latency to every
// request is down no matter what status code it returns.
//
// So: reject immediately when disconnected, cap retries at one, and put a
// hard ceiling on any single command. The failure is then a fast, loud,
// countable error the middleware can act on in single-digit milliseconds
// (see scripts/redis-outage-test.mjs, which measures exactly this).
export const redis = new Redis(env.redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: env.redisConnectTimeoutMs,
  // Covers the other half of the problem: a Redis that is connected but slow
  // (swapping, blocked on a big key, network stall) would otherwise hold the
  // request open indefinitely. Disconnection is not the only way a dependency
  // hurts you.
  commandTimeout: env.redisCommandTimeoutMs,
  retryStrategy: (attempt) => Math.min(attempt * 200, 3000),
});

// During an outage ioredis emits an error per reconnect attempt, several
// times a second. Logging each one buries the rest of the log and costs real
// CPU in the middle of an incident, so collapse them into one line per
// window with a count. Without any listener at all, ioredis prints its own
// "Unhandled error event" spam and the failure stays invisible to metrics.
const ERROR_LOG_INTERVAL_MS = 10_000;
let suppressedErrors = 0;
let lastErrorLoggedAt = 0;

redis.on("error", (err: Error) => {
  suppressedErrors++;
  const now = Date.now();
  if (now - lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) return;
  const extra = suppressedErrors > 1 ? ` (+${suppressedErrors - 1} more in the last ${ERROR_LOG_INTERVAL_MS / 1000}s)` : "";
  console.error(`[redis] ${err.message}${extra}`);
  lastErrorLoggedAt = now;
  suppressedErrors = 0;
});

redis.on("ready", () => console.log(`[redis] connected to ${env.redisUrl}`));

/**
 * Whether Redis is currently usable. Used by the readiness probe to
 * distinguish "this process is alive" from "this process can actually
 * enforce limits" — the two are not the same, and a load balancer should be
 * told which one it's looking at.
 */
export function isRedisReady(): boolean {
  return redis.status === "ready";
}

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
