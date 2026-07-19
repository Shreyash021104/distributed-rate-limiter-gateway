import type { Redis } from "ioredis";
import { redis } from "../redis.js";
import { loadScript } from "./loadScript.js";
import type { Limiter, LimitResult } from "./types.js";

// ioredis's defineCommand registers the script once and transparently uses
// EVALSHA (falling back to EVAL on a cache miss, e.g. after a Redis
// restart) — we don't have to hand-roll that caching ourselves.
redis.defineCommand("tokenBucket", {
  numberOfKeys: 1,
  lua: loadScript("tokenBucket.lua"),
});

declare module "ioredis" {
  interface RedisCommander<Context> {
    tokenBucket(
      key: string,
      capacity: string,
      refillRate: string,
      now: string,
      requested: string
    ): Promise<[number, string, number]>;
  }
}

export interface TokenBucketOptions {
  capacity: number;
  refillRatePerSecond: number;
}

export class TokenBucketLimiter implements Limiter {
  readonly algorithm = "token-bucket" as const;

  constructor(
    private readonly options: TokenBucketOptions,
    private readonly client: Redis = redis
  ) {}

  async check(key: string): Promise<LimitResult> {
    const [allowed, tokensRemaining, retryAfterMs] = await this.client.tokenBucket(
      `tb:${key}`,
      String(this.options.capacity),
      String(this.options.refillRatePerSecond),
      String(Date.now()),
      "1"
    );
    return {
      allowed: allowed === 1,
      remaining: Number(tokensRemaining),
      retryAfterMs,
    };
  }
}
