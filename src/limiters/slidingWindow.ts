import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { redis } from "../redis.js";
import { loadScript } from "./loadScript.js";
import type { Limiter, LimitResult } from "./types.js";

redis.defineCommand("slidingWindowLog", {
  numberOfKeys: 1,
  lua: loadScript("slidingWindowLog.lua"),
});

declare module "ioredis" {
  interface RedisCommander<Context> {
    slidingWindowLog(
      key: string,
      windowMs: string,
      limit: string,
      now: string,
      member: string
    ): Promise<[number, number]>;
  }
}

export interface SlidingWindowOptions {
  limit: number;
  windowMs: number;
}

export class SlidingWindowLimiter implements Limiter {
  readonly algorithm = "sliding-window" as const;

  constructor(
    private readonly options: SlidingWindowOptions,
    private readonly client: Redis = redis
  ) {}

  async check(key: string): Promise<LimitResult> {
    const now = Date.now();
    // A random member per request, not just the timestamp, because two
    // requests can legitimately land in the same millisecond under load —
    // using the timestamp alone as the sorted-set member would silently
    // collapse them into a single log entry and undercount.
    const member = `${now}:${randomUUID()}`;
    const [allowed, count] = await this.client.slidingWindowLog(
      `sw:${key}`,
      String(this.options.windowMs),
      String(this.options.limit),
      String(now),
      member
    );
    return {
      allowed: allowed === 1,
      remaining: Math.max(0, this.options.limit - count),
      retryAfterMs: allowed === 1 ? 0 : this.options.windowMs,
    };
  }
}
