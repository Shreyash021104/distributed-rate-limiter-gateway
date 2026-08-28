import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { redis } from "../redis.js";
import { registerScript } from "./registerScript.js";
import type { Limiter, LimitResult } from "./types.js";

declare module "ioredis" {
  interface RedisCommander<Context> {
    slidingWindowLog(
      key: string,
      windowMs: string,
      limit: string,
      now: string,
      member: string
    ): Promise<[number, number, number, number]>;
  }
}

export interface SlidingWindowOptions {
  limit: number;
  windowMs: number;
}

export class SlidingWindowLimiter implements Limiter {
  readonly algorithm = "sliding-window" as const;
  readonly limit: number;

  constructor(
    private readonly options: SlidingWindowOptions,
    private readonly client: Redis = redis
  ) {
    this.limit = options.limit;
    registerScript(this.client, "slidingWindowLog", "slidingWindowLog.lua", 1);
  }

  async check(key: string): Promise<LimitResult> {
    const now = Date.now();
    // A random member per request, not just the timestamp, because two
    // requests can legitimately land in the same millisecond under load —
    // using the timestamp alone as the sorted-set member would silently
    // collapse them into a single log entry and undercount.
    const member = `${now}:${randomUUID()}`;
    const [allowed, count, retryAfterMs, resetMs] = await this.client.slidingWindowLog(
      `sw:${key}`,
      String(this.options.windowMs),
      String(this.options.limit),
      String(now),
      member
    );
    return {
      allowed: allowed === 1,
      limit: this.limit,
      remaining: Math.max(0, this.options.limit - count),
      retryAfterMs,
      resetMs,
    };
  }
}
