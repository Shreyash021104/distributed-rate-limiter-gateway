// Unit tests for the three limiters, driven against a real Redis rather than
// a mock. Mocking Redis here would test nothing that matters: the entire
// correctness argument of this project lives inside Lua scripts that Redis
// executes, so a fake client would be asserting against a reimplementation
// of the very thing under test.
//
// Requires Redis on REDIS_URL (defaults to localhost:6379) — the same
// dependency the app itself has.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { TokenBucketLimiter } from "../src/limiters/tokenBucket.js";
import { SlidingWindowLimiter } from "../src/limiters/slidingWindow.js";
import { FixedWindowLimiter } from "../src/limiters/fixedWindow.js";
import type { Limiter } from "../src/limiters/types.js";
import { closeRedis } from "../src/redis.js";

// A client of its own, separate from the app's singleton, which doubles as a
// regression test: these limiters used to register their Lua scripts against
// the module-level singleton at import time, so the injected-client
// constructor parameter silently produced a "client.tokenBucket is not a
// function" crash for any other connection. If that regresses, every test
// below fails at construction.
const client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 1,
});

after(async () => {
  await client.quit();
  await closeRedis();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let counter = 0;
const uniqueKey = (prefix: string) => `test:${prefix}:${process.pid}:${Date.now()}:${counter++}`;

describe("token bucket", () => {
  const limit = 5;
  const limiter = new TokenBucketLimiter(
    { capacity: limit, refillRatePerSecond: limit },
    client
  );

  it("allows exactly `capacity` requests before rejecting", async () => {
    const key = uniqueKey("tb-capacity");
    for (let i = 0; i < limit; i++) {
      const result = await limiter.check(key);
      assert.equal(result.allowed, true, `request ${i + 1} should be allowed`);
      assert.equal(result.limit, limit);
    }
    const rejected = await limiter.check(key);
    assert.equal(rejected.allowed, false);
    assert.ok(rejected.retryAfterMs > 0, "a rejected request should say when to retry");
  });

  it("refills over time rather than resetting all at once", async () => {
    const key = uniqueKey("tb-refill");
    for (let i = 0; i < limit; i++) await limiter.check(key);
    assert.equal((await limiter.check(key)).allowed, false);

    // At `limit` tokens per second, ~300ms buys back roughly 1.5 tokens: one
    // request should get through, and the bucket should still be far from
    // full. That partial recovery is the property that distinguishes a token
    // bucket from a window that resets wholesale.
    await sleep(300);
    const afterRefill = await limiter.check(key);
    assert.equal(afterRefill.allowed, true);
    assert.ok(
      afterRefill.remaining < limit - 1,
      `expected a partially refilled bucket, got ${afterRefill.remaining} of ${limit}`
    );
  });

  it("reports resetMs as time to a full bucket, not time to one token", async () => {
    const key = uniqueKey("tb-reset");
    const first = await limiter.check(key);
    assert.ok(first.resetMs > 0, "a bucket missing a token has not fully reset");
    assert.ok(
      first.resetMs >= first.retryAfterMs,
      "refilling the whole bucket cannot take less time than earning one token back"
    );
  });
});

describe("sliding window log", () => {
  const limit = 5;
  const windowMs = 2000;
  const limiter = new SlidingWindowLimiter({ limit, windowMs }, client);

  it("allows exactly `limit` requests in the window", async () => {
    const key = uniqueKey("sw-limit");
    for (let i = 0; i < limit; i++) {
      assert.equal((await limiter.check(key)).allowed, true, `request ${i + 1}`);
    }
    assert.equal((await limiter.check(key)).allowed, false);
  });

  it("reports retryAfterMs from the oldest entry, not the full window", async () => {
    const key = uniqueKey("sw-retry");
    for (let i = 0; i < limit; i++) await limiter.check(key);
    // Half the window has passed, so the oldest entry ages out in roughly the
    // remaining half. Returning the full window here (the shortcut this used
    // to take) would tell the client to wait twice as long as it needs to.
    await sleep(windowMs / 2);
    const rejected = await limiter.check(key);
    assert.equal(rejected.allowed, false);
    assert.ok(
      rejected.retryAfterMs > 0 && rejected.retryAfterMs < windowMs * 0.75,
      `expected retryAfterMs well under the full ${windowMs}ms window, got ${rejected.retryAfterMs}`
    );
  });

  it("frees a slot once the oldest request ages out", async () => {
    const key = uniqueKey("sw-expiry");
    for (let i = 0; i < limit; i++) await limiter.check(key);
    assert.equal((await limiter.check(key)).allowed, false);
    await sleep(windowMs + 100);
    assert.equal((await limiter.check(key)).allowed, true);
  });
});

describe("fixed window counter", () => {
  const limit = 5;
  const windowSeconds = 1;
  const limiter = new FixedWindowLimiter({ limit, windowSeconds }, client);

  it("allows exactly `limit` requests in the window", async () => {
    const key = uniqueKey("fw-limit");
    for (let i = 0; i < limit; i++) {
      assert.equal((await limiter.check(key)).allowed, true, `request ${i + 1}`);
    }
    assert.equal((await limiter.check(key)).allowed, false);
  });

  it("reports resetMs as time to the window boundary, not the key's TTL", async () => {
    const key = uniqueKey("fw-reset");
    const result = await limiter.check(key);
    // The TTL is set when the window's first request creates the key, so it
    // runs a full window from *then* and overshoots the boundary that
    // actually resets the counter. resetMs must track the boundary.
    assert.ok(
      result.resetMs > 0 && result.resetMs <= windowSeconds * 1000,
      `resetMs ${result.resetMs} should be within one ${windowSeconds}s window`
    );
  });
});

describe("atomicity under concurrency", () => {
  // The point of doing the check-and-increment inside a Lua script is that
  // concurrent callers cannot interleave a read with someone else's write. A
  // read-decide-write implementation passes every sequential test above and
  // fails this one, because a burst of simultaneous requests all read the
  // same pre-increment count and all decide they're under the limit.
  const limit = 10;
  const burst = limit * 5;

  const cases: Array<[string, Limiter]> = [
    ["token bucket", new TokenBucketLimiter({ capacity: limit, refillRatePerSecond: 0.001 }, client)],
    ["sliding window", new SlidingWindowLimiter({ limit, windowMs: 60_000 }, client)],
    ["fixed window", new FixedWindowLimiter({ limit, windowSeconds: 60 }, client)],
  ];

  for (const [name, limiter] of cases) {
    it(`${name} allows exactly ${limit} of ${burst} simultaneous requests`, async () => {
      const key = uniqueKey(`atomic-${name.replace(/\s/g, "-")}`);
      const results = await Promise.all(
        Array.from({ length: burst }, () => limiter.check(key))
      );
      const allowed = results.filter((r) => r.allowed).length;
      assert.equal(
        allowed,
        limit,
        `${allowed} of ${burst} concurrent requests were allowed against a limit of ${limit} — ` +
          `over-allowing here means the check and the increment are not happening atomically`
      );
    });
  }
});

describe("key isolation", () => {
  it("does not let one client's traffic exhaust another's budget", async () => {
    const limit = 3;
    const limiter = new FixedWindowLimiter({ limit, windowSeconds: 60 }, client);
    const noisy = uniqueKey("isolation-noisy");
    const quiet = uniqueKey("isolation-quiet");

    for (let i = 0; i < limit + 5; i++) await limiter.check(noisy);
    assert.equal((await limiter.check(noisy)).allowed, false);

    const other = await limiter.check(quiet);
    assert.equal(other.allowed, true);
    assert.equal(other.remaining, limit - 1);
  });
});
