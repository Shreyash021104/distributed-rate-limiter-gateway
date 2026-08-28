// Integration test: proves the gateway's fail-open policy is real, not
// aspirational — that a Redis outage costs milliseconds per request rather
// than seconds.
//
// The README argues the gateway should fail open when Redis is unreachable,
// on the grounds that a briefly-unenforced rate limit is a smaller incident
// than a gateway that 500s everything behind it. That argument only holds if
// failing open is *fast*. With ioredis's default client options it wasn't:
// `enableOfflineQueue` parks commands in memory while disconnected instead
// of rejecting them, and `maxRetriesPerRequest: 20` keeps them parked across
// twenty reconnect attempts. Measured against a dead Redis before the fix,
// single requests took 2.5s, 7.1s, and one hadn't returned after 30 seconds.
// Each one technically "failed open" and each one was useless — a gateway
// adding seconds of latency to every request is down regardless of the
// status code it eventually returns.
//
// So this asserts the property that actually matters: with Redis gone, every
// request still succeeds AND every request is fast. It also checks the
// failure is *visible* — an unenforced gateway that looks healthy on every
// dashboard is the worse version of this bug.
//
// Usage: node scripts/redis-outage-test.mjs

import {
  spawnProcess,
  waitForHealthy,
  findClosedPort,
  killAll,
  percentile,
} from "./lib/harness.mjs";

const UPSTREAM_PORT = 9300;
const GATEWAY_PORT = 8380;
const REQUESTS = 20;

// Generous by two orders of magnitude against the pre-fix numbers above, so
// this passes comfortably on a loaded CI runner while still failing loudly if
// the offline-queue behavior ever comes back.
const MAX_ACCEPTABLE_MS = 1000;

async function timedGet(url, apiKey) {
  const start = performance.now();
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
  return { status: res.status, ms: performance.now() - start, headers: res.headers };
}

async function main() {
  const deadRedisPort = await findClosedPort();

  const upstream = spawnProcess("upstream", "src/mockUpstream.ts", {
    MOCK_UPSTREAM_PORT: String(UPSTREAM_PORT),
  });
  const gateway = spawnProcess("gateway", "src/index.ts", {
    PORT: String(GATEWAY_PORT),
    UPSTREAM_URL: `http://localhost:${UPSTREAM_PORT}`,
    REDIS_URL: `redis://localhost:${deadRedisPort}`,
    RATE_LIMIT: "5",
    RATE_WINDOW_SECONDS: "10",
    INSTANCE_ID: "redis-outage-test",
  });

  try {
    await waitForHealthy(`http://localhost:${UPSTREAM_PORT}/health`);
    // Liveness must stay green with Redis gone. If it didn't, an orchestrator
    // would restart every replica over a dependency the gateway is
    // specifically designed to survive.
    await waitForHealthy(`http://localhost:${GATEWAY_PORT}/health`);

    const apiKey = `redis-outage-${Date.now()}`;
    const latencies = [];
    const statuses = new Map();
    let unenforcedHeaderSeen = 0;

    for (let i = 0; i < REQUESTS; i++) {
      const { status, ms, headers } = await timedGet(
        `http://localhost:${GATEWAY_PORT}/api/fw/test`,
        apiKey
      );
      latencies.push(ms);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      if (headers.get("x-ratelimit-enforced") === "false") unenforcedHeaderSeen++;
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const max = sorted[sorted.length - 1];
    const allowed = statuses.get(200) ?? 0;

    // Readiness must go red even though liveness stayed green — that split is
    // the whole point of having two probes.
    const readyRes = await fetch(`http://localhost:${GATEWAY_PORT}/ready`);
    const metrics = await (await fetch(`http://localhost:${GATEWAY_PORT}/metrics`)).text();
    const failedOpenMatch = metrics.match(
      /gateway_requests_total\{[^}]*outcome="failed_open"[^}]*\}\s+(\d+)/
    );
    const failedOpenCount = failedOpenMatch ? Number(failedOpenMatch[1]) : 0;
    const errorsCounted = /gateway_limiter_errors_total\{[^}]*\}\s+[1-9]/.test(metrics);

    console.log(`\nRedis unreachable (port ${deadRedisPort}), ${REQUESTS} requests sent:`);
    console.log(`  statuses:        ${[...statuses].map(([s, n]) => `${s}x${n}`).join(", ")}`);
    console.log(`  latency p50:     ${p50.toFixed(1)}ms`);
    console.log(`  latency p95:     ${p95.toFixed(1)}ms`);
    console.log(`  latency max:     ${max.toFixed(1)}ms  (budget ${MAX_ACCEPTABLE_MS}ms)`);
    console.log(`  /health:         200 (liveness unaffected, as intended)`);
    console.log(`  /ready:          ${readyRes.status} (expected 503 — not enforcing)`);
    console.log(`  failed_open:     ${failedOpenCount} requests counted in /metrics`);

    const failures = [];
    if (allowed !== REQUESTS) {
      failures.push(
        `expected all ${REQUESTS} requests to fail open with 200, got ${allowed}. ` +
          `The gateway is failing closed on a Redis outage — it takes its own upstream down with it.`
      );
    }
    if (max > MAX_ACCEPTABLE_MS) {
      failures.push(
        `slowest request took ${max.toFixed(0)}ms, over the ${MAX_ACCEPTABLE_MS}ms budget. ` +
          `Requests are queueing while Redis is down instead of failing fast — check ` +
          `enableOfflineQueue/maxRetriesPerRequest/commandTimeout in src/redis.ts.`
      );
    }
    if (readyRes.status !== 503) {
      failures.push(
        `expected /ready to report 503 while Redis is down, got ${readyRes.status}. ` +
          `A gateway that isn't enforcing limits should not claim it is.`
      );
    }
    if (failedOpenCount < REQUESTS || !errorsCounted) {
      failures.push(
        `expected at least ${REQUESTS} failed_open requests and a non-zero ` +
          `gateway_limiter_errors_total in /metrics, got ${failedOpenCount} and ` +
          `errors=${errorsCounted}. An uncounted fail-open means the gateway silently ` +
          `stops enforcing limits while every dashboard stays green.`
      );
    }
    if (unenforcedHeaderSeen !== REQUESTS) {
      failures.push(
        `expected every fail-open response to carry X-RateLimit-Enforced: false, saw ` +
          `${unenforcedHeaderSeen}/${REQUESTS}.`
      );
    }

    if (failures.length > 0) {
      for (const f of failures) console.error(`FAIL: ${f}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `\nPASS: with Redis unreachable, all ${REQUESTS} requests were served in ` +
        `${max.toFixed(0)}ms or less (p95 ${p95.toFixed(0)}ms) instead of stalling on a ` +
        `retry queue, and the unenforced state is visible in both /ready and /metrics.`
    );
  } finally {
    killAll(upstream, gateway);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
