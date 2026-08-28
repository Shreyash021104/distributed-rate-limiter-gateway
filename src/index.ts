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

// Set as soon as a shutdown signal arrives so /ready can report it before
// the server stops accepting connections.
let shuttingDown = false;

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
  const enforcing = isRedisReady();
  // Reports not-ready the moment a shutdown starts, before the socket
  // actually closes. That ordering is the whole value of a readiness probe
  // during a deploy: the load balancer sees 503 and stops sending new
  // requests while the process is still able to finish the ones it has.
  // Closing first and letting the balancer find out by connection refusal
  // turns every rolling deploy into a handful of client-visible errors.
  const ready = enforcing && !shuttingDown;
  res.status(ready ? 200 : 503).json({
    ready,
    instance: env.instanceId,
    redis: redis.status,
    enforcing,
    draining: shuttingDown,
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
      // No pathRewrite: app.use(prefix) has already stripped the mount path
      // from req.url by the time the proxy sees it, so a `^/api/tb` rule
      // would never match anything. Verified by asking the upstream what
      // path it received — /api/tb/hello/world arrives as /hello/world.
      //
      // Timeouts are the load-bearing config here. An upstream that accepts
      // the connection and then never answers otherwise holds a gateway
      // socket open forever: measured without these, a request to a hung
      // upstream was still waiting when the client gave up at 25 seconds.
      // A gateway with no upstream deadline hoards its own connections on
      // behalf of a backend that is already failing.
      // proxyTimeout only, deliberately. Its sibling `timeout` applies to the
      // *incoming* socket, and setting both means the incoming one can fire
      // first and destroy the connection without ever reaching the error
      // handler below — the client gets a dead socket instead of a 504, and
      // nothing is logged or counted. Slow clients are a separate concern
      // from slow upstreams; only the latter is what this deadline is for.
      proxyTimeout: env.upstreamTimeoutMs,
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
            // 504 for "the upstream ran out of time", 502 for "the upstream
            // was unreachable or broke the connection". Collapsing both into
            // 502 loses the distinction between a backend that is down and
            // one that is merely too slow — different pages, different fixes.
            const timedOut = code === "ETIMEDOUT" || code === "ECONNRESET";
            response
              .status(timedOut ? 504 : 502)
              .json({
                error: timedOut ? "Gateway Timeout" : "Bad Gateway",
                upstream: env.upstreamUrl,
              });
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
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${env.instanceId}] ${signal} received, draining in-flight requests…`);

  const closeAndExit = () => {
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
  };

  if (env.readinessDrainMs > 0) {
    // Keep the listener open for this window so health checks can actually
    // see the 503 that /ready is now returning, and route traffic elsewhere
    // before the socket disappears.
    console.log(
      `[${env.instanceId}] reporting not-ready for ${env.readinessDrainMs}ms before closing`
    );
    setTimeout(closeAndExit, env.readinessDrainMs).unref();
  } else {
    closeAndExit();
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
