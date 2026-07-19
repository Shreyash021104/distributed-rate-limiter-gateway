// Empirically demonstrates the classic "boundary burst" weakness of fixed
// window counters, and shows sliding window log doesn't have it — this is
// the actual trade-off the README claims between the two algorithms,
// measured here rather than just asserted.
//
// Strategy: align to just before a fixed-window boundary, fire `limit`
// requests, wait for the window to roll over, then immediately fire
// `limit` more. All of this happens within a span much shorter than the
// window itself:
//   - Fixed window: both batches land in different window buckets, so all
//     2x limit requests are allowed — a real burst of 2x the intended rate.
//   - Sliding window log: it always looks back exactly `window` from *now*,
//     with no fixed boundary to exploit, so the second batch is correctly
//     throttled since the first batch is still within the trailing window.
//
// Usage: node scripts/boundary-burst-test.mjs

import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const LIMIT = 5;
const WINDOW_SECONDS = 2;
const WINDOW_MS = WINDOW_SECONDS * 1000;

function spawnProcess(name, scriptPath, env) {
  const child = spawn("npx", ["tsx", scriptPath], {
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

async function fireBatch(url, apiKey, count) {
  let allowed = 0;
  for (let i = 0; i < count; i++) {
    const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (res.status === 200) allowed++;
  }
  return allowed;
}

// Waits until just before the next fixed-window boundary rolls over, so the
// first batch lands right at the end of one window.
async function waitUntilNearWindowBoundary(marginMs = 150) {
  const msIntoWindow = Date.now() % WINDOW_MS;
  const msUntilBoundary = WINDOW_MS - msIntoWindow;
  const waitMs = Math.max(0, msUntilBoundary - marginMs);
  await new Promise((r) => setTimeout(r, waitMs));
}

async function main() {
  const upstream = spawnProcess("upstream", "src/mockUpstream.ts", { MOCK_UPSTREAM_PORT: "9200" });
  const gateway = spawnProcess("gateway", "src/index.ts", {
    PORT: "8280",
    UPSTREAM_URL: "http://localhost:9200",
    RATE_LIMIT: String(LIMIT),
    RATE_WINDOW_SECONDS: String(WINDOW_SECONDS),
    INSTANCE_ID: "boundary-test",
  });

  const cleanup = () => {
    upstream.kill();
    gateway.kill();
  };

  try {
    await waitForHealthy("http://localhost:9200/health");
    await waitForHealthy("http://localhost:8280/health");

    // --- Fixed window ---
    const fwKey = `boundary-fw-${Date.now()}`;
    await waitUntilNearWindowBoundary();
    const fwBatch1 = await fireBatch("http://localhost:8280/api/fw/test", fwKey, LIMIT);
    await new Promise((r) => setTimeout(r, 300)); // cross the window boundary
    const fwBatch2 = await fireBatch("http://localhost:8280/api/fw/test", fwKey, LIMIT);
    const fwTotal = fwBatch1 + fwBatch2;

    // --- Sliding window log, identical timing pattern ---
    const swKey = `boundary-sw-${Date.now()}`;
    await waitUntilNearWindowBoundary();
    const swBatch1 = await fireBatch("http://localhost:8280/api/sw/test", swKey, LIMIT);
    await new Promise((r) => setTimeout(r, 300));
    const swBatch2 = await fireBatch("http://localhost:8280/api/sw/test", swKey, LIMIT);
    const swTotal = swBatch1 + swBatch2;

    console.log(`\nFixed window:    batch1=${fwBatch1} batch2=${fwBatch2} total=${fwTotal} (limit=${LIMIT})`);
    console.log(`Sliding window:  batch1=${swBatch1} batch2=${swBatch2} total=${swTotal} (limit=${LIMIT})`);

    let failed = false;
    if (fwTotal <= LIMIT) {
      console.error(
        `FAIL: expected fixed window to allow a boundary burst (>${LIMIT} total across the two batches), got ${fwTotal}. ` +
          `Either the timing didn't land near a boundary, or the burst behavior isn't reproducing.`
      );
      failed = true;
    }
    if (swTotal > LIMIT) {
      console.error(
        `FAIL: expected sliding window to cap total at ${LIMIT} regardless of the boundary, got ${swTotal}.`
      );
      failed = true;
    }

    if (failed) {
      process.exitCode = 1;
      return;
    }

    console.log(
      `\nPASS: fixed window let ${fwTotal} requests through across a window boundary (${fwTotal - LIMIT} over the ` +
        `configured limit of ${LIMIT}); sliding window correctly capped the same traffic pattern at ${swTotal}.`
    );
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
