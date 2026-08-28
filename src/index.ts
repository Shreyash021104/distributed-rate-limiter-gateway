import http from "node:http";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { Request, Response } from "express";
import { env } from "./env.js";
import { registry, upstreamErrorsTotal } from "./metrics.js";
import { rateLimitMiddleware } from "./rateLimitMiddleware.js";
import { redis, isRedisReady, closeRedis } from "./redis.js";
import type { Limiter } from "./limiters/types.js";
import { TokenBucketLimiter } from "./limiters/tokenBucket.js";
import { SlidingWindowLimiter } from "./limiters/slidingWindow.js";
import { FixedWindowLimiter } from "./limiters/fixedWindow.js";

const app = express();

// Decides what req.ip resolves to, which decides how anonymous traffic is
// bucketed. See the note in env.ts — this is a correctness setting for the
// limiter, not a cosmetic one.
app.set("trust proxy", env.trustProxy);

// Liveness: is this process running at all? Deliberately does not touch
// Redis. If it did, a Redis outage would make every replica fail its health
// check, the orchestrator would restart all of them, and an outage in a
// dependency the gateway is explicitly designed to survive would turn into
// an outage of the gateway itself.
app.get("/health", (_req, res) => res.json({ ok: true, instance: env.instanceId }));

// Readiness: can this process actually enforce limits? Separate answer, and
// the one you want when deciding whether to route traffic here in a
// fail-closed deployment. Fail-open means a not-ready gateway is still
// useful, so this reports the state rather than forcing a decision.
app.get("/ready", (_req, res) => {
  const ready = isRedisReady();
  res.status(ready ? 200 : 503).json({
    ready,
    instance: env.instanceId,
    redis: redis.status,
    enforcing: ready,
  });
});

app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

// All three algorithms are mounted simultaneously, each behind its own path
// prefix, enforcing the identical configured limit (env.limit requests per
// env.windowSeconds). That's deliberate: it lets the same load-test script
// hit /api/tb, /api/sw, and /api/fw back to back and produce a real,
// apples-to-apples comparison of how each behaves under the exact same
// traffic pattern, instead of comparing them in isolation on different runs.
function mount(prefix: string, limiter: Limiter): void {
  app.use(
    prefix,
    rateLimitMiddleware(limiter),
    createProxyMiddleware({
      target: env.upstreamUrl,
      changeOrigin: true,
      pathRewrite: { [`^${prefix}`]: "" },
      on: {
        // Without this, an unreachable upstream surfaces as a bare socket
        // error with no log line and no metric — the gateway would be
        // reporting a healthy rate limiter while everything behind it was
        // down. 502 is the accurate code: the limiter said yes, the thing
        // downstream is what failed.
        error: (err, _req, res) => {
          const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
          upstreamErrorsTotal.inc({ algorithm: limiter.algorithm, code });
          console.error(`[${limiter.algorithm}] upstream request failed (${code}):`, err.message);
          const response = res as Response;
          if (typeof response.status === "function" && !response.headersSent) {
            response.status(502).json({ error: "Bad Gateway", upstream: env.upstreamUrl });
          } else {
            (res as unknown as { destroy: () => void }).destroy();
          }
        },
      },
    })
  );
}

mount(
  "/api/tb",
  new TokenBucketLimiter({
    capacity: env.limit,
    refillRatePerSecond: env.limit / env.windowSeconds,
  })
);
mount("/api/sw", new SlidingWindowLimiter({ limit: env.limit, windowMs: env.windowSeconds * 1000 }));
mount("/api/fw", new FixedWindowLimiter({ limit: env.limit, windowSeconds: env.windowSeconds }));

const server = http.createServer(app);
server.listen(env.port, () => {
  console.log(
    `Gateway [${env.instanceId}] listening on http://localhost:${env.port} ` +
      `(limit=${env.limit}/${env.windowSeconds}s, upstream=${env.upstreamUrl})`
  );
});

// A container gets SIGTERM and then, some seconds later, SIGKILL. Without a
// handler the process dies at the first signal, cutting every in-flight
// proxied request mid-response — visible to clients as a connection reset
// during what should be a routine deploy or scale-down.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${env.instanceId}] ${signal} received, draining in-flight requests…`);

  const force = setTimeout(() => {
    console.error(`[${env.instanceId}] drain exceeded ${env.shutdownGraceMs}ms, forcing exit`);
    process.exit(1);
  }, env.shutdownGraceMs);
  force.unref();

  server.close(async () => {
    await closeRedis();
    clearTimeout(force);
    console.log(`[${env.instanceId}] shutdown complete`);
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
