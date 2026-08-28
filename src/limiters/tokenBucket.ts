import type { Redis } from "ioredis";
import { redis } from "../redis.js";
import { registerScript } from "./registerScript.js";
import type { Limiter, LimitResult } from "./types.js";

declare module "ioredis" {
  interface RedisCommander<Context> {
    tokenBucket(
      key: string,
      capacity: string,
      refillRate: string,
      now: string,
      requested: string
    ): Promise<[number, string, number, number]>;
  }
}

export interface TokenBucketOptions {
  capacity: number;
  refillRatePerSecond: number;
}

export class TokenBucketLimiter implements Limiter {
  readonly algorithm = "token-bucket" as const;
  readonly limit: number;

  constructor(
    private readonly options: TokenBucketOptions,
    private readonly client: Redis = redis
  ) {
    this.limit = options.capacity;
    registerScript(this.client, "tokenBucket", "tokenBucket.lua", 1);
  }

  async check(key: string): Promise<LimitResult> {
    const [allowed, tokensRemaining, retryAfterMs, resetMs] = await this.client.tokenBucket(
      `tb:${key}`,
      String(this.options.capacity),
      String(this.options.refillRatePerSecond),
      String(Date.now()),
      "1"
    );
    return {
      allowed: allowed === 1,
      limit: this.limit,
      remaining: Number(tokensRemaining),
      retryAfterMs,
      resetMs,
    };
  }
}
