import http from "node:http";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { env } from "./env.js";
import { registry } from "./metrics.js";
import { rateLimitMiddleware } from "./rateLimitMiddleware.js";
import { TokenBucketLimiter } from "./limiters/tokenBucket.js";
import { SlidingWindowLimiter } from "./limiters/slidingWindow.js";
import { FixedWindowLimiter } from "./limiters/fixedWindow.js";

const app = express();

app.get("/health", (_req, res) => res.json({ ok: true, instance: env.instanceId }));

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

const tokenBucket = new TokenBucketLimiter({
  capacity: env.limit,
  refillRatePerSecond: env.limit / env.windowSeconds,
});
app.use(
  "/api/tb",
  rateLimitMiddleware(tokenBucket),
  createProxyMiddleware({
    target: env.upstreamUrl,
    changeOrigin: true,
    pathRewrite: { "^/api/tb": "" },
  })
);

const slidingWindow = new SlidingWindowLimiter({
  limit: env.limit,
  windowMs: env.windowSeconds * 1000,
});
app.use(
  "/api/sw",
  rateLimitMiddleware(slidingWindow),
  createProxyMiddleware({
    target: env.upstreamUrl,
    changeOrigin: true,
    pathRewrite: { "^/api/sw": "" },
  })
);

const fixedWindow = new FixedWindowLimiter({
  limit: env.limit,
  windowSeconds: env.windowSeconds,
});
app.use(
  "/api/fw",
  rateLimitMiddleware(fixedWindow),
  createProxyMiddleware({
    target: env.upstreamUrl,
    changeOrigin: true,
    pathRewrite: { "^/api/fw": "" },
  })
);

const server = http.createServer(app);
server.listen(env.port, () => {
  console.log(
    `Gateway [${env.instanceId}] listening on http://localhost:${env.port} ` +
      `(limit=${env.limit}/${env.windowSeconds}s, upstream=${env.upstreamUrl})`
  );
});
