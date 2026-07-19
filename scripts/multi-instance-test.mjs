// Integration test: proves the rate limit is enforced globally across
// multiple gateway instances via shared Redis state, not per-instance in
// memory. This is the entire point of the project — a naive in-memory
// counter would let a client get `limit` requests through EACH instance it
// hits, effectively multiplying its rate limit by the number of instances
// behind the load balancer.
//
// Spins up two real gateway processes on different ports (both pointed at
// the same Redis and same mock upstream), alternates requests between them
// with the same API key, and asserts the total allowed count across BOTH
// instances equals the configured limit — not double it.
//
// Usage: node scripts/multi-instance-test.mjs

import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const LIMIT = 5;
const WINDOW_SECONDS = 10;

function spawnProcess(name, scriptPath, env) {
  // Invoke the locally-installed tsx binary directly rather than going
  // through `npx tsx` — npx's resolution behaves differently across
  // environments (it hung indefinitely in GitHub Actions CI despite
  // working fine locally, even though tsx is already a devDependency and
  // should never need to be fetched).
  const child = spawn(TSX_BIN, [scriptPath], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

async function waitForHealthy(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} never became healthy`);
}

async function main() {
  const upstream = spawnProcess("upstream", "src/mockUpstream.ts", {
    MOCK_UPSTREAM_PORT: "9100",
  });
  const gatewayA = spawnProcess("gw-A", "src/index.ts", {
    PORT: "8180",
    UPSTREAM_URL: "http://localhost:9100",
    RATE_LIMIT: String(LIMIT),
    RATE_WINDOW_SECONDS: String(WINDOW_SECONDS),
    INSTANCE_ID: "test-instance-A",
  });
  const gatewayB = spawnProcess("gw-B", "src/index.ts", {
    PORT: "8181",
    UPSTREAM_URL: "http://localhost:9100",
    RATE_LIMIT: String(LIMIT),
    RATE_WINDOW_SECONDS: String(WINDOW_SECONDS),
    INSTANCE_ID: "test-instance-B",
  });

  const cleanup = () => {
    upstream.kill();
    gatewayA.kill();
    gatewayB.kill();
  };

  try {
    await waitForHealthy("http://localhost:9100/health");
    await waitForHealthy("http://localhost:8180/health");
    await waitForHealthy("http://localhost:8181/health");

    const apiKey = `multi-instance-test-${Date.now()}`;
    const ports = [8180, 8181];
    let allowed = 0;
    let rejected = 0;

    // 3x the limit's worth of requests, alternating instances, so a bug
    // that gives each instance its own independent quota would show up as
    // roughly `limit` allowed per instance (2x limit total) instead of
    // exactly `limit` allowed overall.
    const totalRequests = LIMIT * 3;
    for (let i = 0; i < totalRequests; i++) {
      const port = ports[i % 2];
      const res = await fetch(`http://localhost:${port}/api/fw/test`, {
        headers: { "X-API-Key": apiKey },
      });
      if (res.status === 200) allowed++;
      else if (res.status === 429) rejected++;
      else throw new Error(`unexpected status ${res.status} from instance on port ${port}`);
    }

    console.log(`Allowed: ${allowed}, Rejected: ${rejected} (configured limit: ${LIMIT})`);

    if (allowed !== LIMIT) {
      console.error(
        `FAIL: expected exactly ${LIMIT} allowed requests across both instances combined, got ${allowed}. ` +
          `If this is higher than ${LIMIT}, the rate limit is being tracked per-instance instead of globally.`
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `PASS: exactly ${LIMIT} requests allowed across two gateway instances sharing one Redis-backed limit — ` +
        `no per-instance quota multiplication.`
    );
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
