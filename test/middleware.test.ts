// Tests for the middleware's contract with clients: which headers it emits,
// what it does when the limiter itself fails, and whether that failure is
// observable. Driven through a real Express app over a real socket, with a
// stub limiter standing in for Redis — the limiter's own behavior is covered
// in limiters.test.ts, so what's under test here is purely the HTTP surface.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { rateLimitMiddleware } from "../src/rateLimitMiddleware.js";
import type { Limiter, LimitResult } from "../src/limiters/types.js";

class StubLimiter implements Limiter {
  readonly algorithm = "fixed-window" as const;
  readonly limit = 3;
  /** The key the middleware derived for the most recent request. */
  lastKey = "";
  constructor(private readonly behavior: () => Promise<LimitResult>) {}
  check(key: string): Promise<LimitResult> {
    this.lastKey = key;
    return this.behavior();
  }
}

const allowing = new StubLimiter(async () => ({
  allowed: true,
  limit: 3,
  remaining: 2,
  retryAfterMs: 0,
  resetMs: 7_000,
}));

const rejecting = new StubLimiter(async () => ({
  allowed: false,
  limit: 3,
  remaining: 0,
  retryAfterMs: 4_200,
  resetMs: 4_200,
}));

const broken = new StubLimiter(async () => {
  throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
});

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use("/allow", rateLimitMiddleware(allowing), (_req, res) => res.json({ ok: true }));
  app.use("/reject", rateLimitMiddleware(rejecting), (_req, res) => res.json({ ok: true }));
  app.use("/broken", rateLimitMiddleware(broken), (_req, res) => res.json({ ok: true }));
  app.get("/metrics", async (_req, res) => {
    const { registry } = await import("../src/metrics.js");
    res.setHeader("Content-Type", registry.contentType);
    res.send(await registry.metrics());
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("rate limit headers", () => {
  it("tells an allowed client its limit, remaining budget, and reset time", async () => {
    const res = await fetch(`${baseUrl}/allow`);
    assert.equal(res.status, 200);
    // Remaining alone — which is all this used to send — leaves a client
    // unable to work out what it's remaining out of, or when its budget
    // comes back.
    assert.equal(res.headers.get("ratelimit-limit"), "3");
    assert.equal(res.headers.get("ratelimit-remaining"), "2");
    assert.equal(res.headers.get("ratelimit-reset"), "7");
    // Legacy spellings too: clients in the wild read either.
    assert.equal(res.headers.get("x-ratelimit-limit"), "3");
    assert.equal(res.headers.get("x-ratelimit-algorithm"), "fixed-window");
  });

  it("sends 429 with a Retry-After rounded up, never down", async () => {
    const res = await fetch(`${baseUrl}/reject`);
    assert.equal(res.status, 429);
    // 4200ms must round to 5s, not 4 — telling a client to retry before its
    // budget exists guarantees a second rejection.
    assert.equal(res.headers.get("retry-after"), "5");
    const body = (await res.json()) as { retryAfterMs: number; algorithm: string };
    assert.equal(body.retryAfterMs, 4200);
    assert.equal(body.algorithm, "fixed-window");
  });
});

describe("key derivation", () => {
  it("bounds key material a client controls, so it cannot dictate Redis key size", async () => {
    // Whatever the caller sends ends up inside a Redis key. Unbounded, a
    // client can send a 16KB header (Node's limit) and mint a 16KB Redis key
    // per distinct value — a rate limiter turned into a memory amplifier
    // aimed at the store it depends on. Measured before the cap: a 7,000
    // character header produced a 7,018 byte key.
    const huge = "A".repeat(7000);
    const res = await fetch(`${baseUrl}/allow`, { headers: { "X-API-Key": huge } });
    assert.equal(res.status, 200, "an unusual key should still be served, just bounded");
    assert.ok(
      allowing.lastKey.length < 128,
      `key material should be bounded, got ${allowing.lastKey.length} characters`
    );
    assert.ok(!allowing.lastKey.includes(huge), "the raw oversized value must not reach Redis");
  });

  it("keeps normal keys readable rather than hashing everything", async () => {
    // Hashing unconditionally would make every Redis key opaque, which costs
    // real debugging time for no benefit — the problem is only unbounded
    // length.
    await fetch(`${baseUrl}/allow`, { headers: { "X-API-Key": "customer-42" } });
    assert.equal(allowing.lastKey, "key:customer-42");
  });

  it("gives two different oversized keys two different buckets", async () => {
    await fetch(`${baseUrl}/allow`, { headers: { "X-API-Key": "B".repeat(7000) } });
    const first = allowing.lastKey;
    await fetch(`${baseUrl}/allow`, { headers: { "X-API-Key": "C".repeat(7000) } });
    assert.notEqual(first, allowing.lastKey, "distinct clients must not collapse into one bucket");
  });
});

describe("fail open", () => {
  it("serves the request when the limiter cannot reach Redis", async () => {
    const res = await fetch(`${baseUrl}/broken`);
    assert.equal(res.status, 200, "a Redis outage must not take the upstream down with it");
    assert.equal(
      res.headers.get("x-ratelimit-enforced"),
      "false",
      "a client should be told when its response was not actually rate limited"
    );
  });

  it("counts the fail-open so it is not silently invisible", async () => {
    await fetch(`${baseUrl}/broken`);
    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(metrics, /gateway_requests_total\{[^}]*outcome="failed_open"[^}]*\}\s+[1-9]/);
    // The reason is classified, not lumped into a generic bucket: "Redis is
    // gone" and "Redis is up but too slow" call for different responses.
    assert.match(metrics, /gateway_limiter_errors_total\{[^}]*reason="unavailable"[^}]*\}\s+[1-9]/);
  });
});
