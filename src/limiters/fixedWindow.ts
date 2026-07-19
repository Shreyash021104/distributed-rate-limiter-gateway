import type { Redis } from "ioredis";
import { redis } from "../redis.js";
import { loadScript } from "./loadScript.js";
import type { Limiter, LimitResult } from "./types.js";

redis.defineCommand("fixedWindow", {
  numberOfKeys: 1,
  lua: loadScript("fixedWindow.lua"),
});

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

  constructor(
    private readonly options: FixedWindowOptions,
    private readonly client: Redis = redis
  ) {}

  async check(key: string): Promise<LimitResult> {
    const windowBucket = Math.floor(Date.now() / (this.options.windowSeconds * 1000));
    const [allowed, count] = await this.client.fixedWindow(
      `fw:${key}:${windowBucket}`,
      String(this.options.limit),
      String(this.options.windowSeconds)
    );
    return {
      allowed: allowed === 1,
      remaining: Math.max(0, this.options.limit - count),
      // Retry-After is "time left in this window" — the client can't
      // usefully retry sooner than that, since the counter won't reset
      // until the window rolls over.
      retryAfterMs:
        allowed === 1
          ? 0
          : this.options.windowSeconds * 1000 - (Date.now() % (this.options.windowSeconds * 1000)),
    };
  }
}
