import type { Redis } from "ioredis";
import { redis } from "../redis.js";
import { registerScript } from "./registerScript.js";
import type { Limiter, LimitResult } from "./types.js";

declare module "ioredis" {
  interface RedisCommander<Context> {
    fixedWindow(key: string, limit: string, windowSeconds: string): Promise<[number, number]>;
  }
}

export interface FixedWindowOptions {
  limit: number;
  windowSeconds: number;
}

export class FixedWindowLimiter implements Limiter {
  readonly algorithm = "fixed-window" as const;
  readonly limit: number;

  constructor(
    private readonly options: FixedWindowOptions,
    private readonly client: Redis = redis
  ) {
    this.limit = options.limit;
    registerScript(this.client, "fixedWindow", "fixedWindow.lua", 1);
  }

  async check(key: string): Promise<LimitResult> {
    const windowMs = this.options.windowSeconds * 1000;
    const now = Date.now();
    const windowBucket = Math.floor(now / windowMs);
    const [allowed, count] = await this.client.fixedWindow(
      `fw:${key}:${windowBucket}`,
      String(this.options.limit),
      String(this.options.windowSeconds)
    );
    // Time left in the current window, computed from the boundary rather than
    // read back as the key's TTL. They aren't the same thing: the TTL starts
    // when the window's first request creates the key, which is usually
    // partway into the window, so it runs past the boundary and would
    // over-report. The boundary is what actually resets the counter, because
    // rolling over changes the key.
    const msUntilWindowRollover = windowMs - (now % windowMs);
    return {
      allowed: allowed === 1,
      limit: this.limit,
      remaining: Math.max(0, this.options.limit - count),
      retryAfterMs: allowed === 1 ? 0 : msUntilWindowRollover,
      resetMs: msUntilWindowRollover,
    };
  }
}
