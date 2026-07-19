// k6 load test comparing all three rate-limiting algorithms under the same
// concurrent traffic pattern.
//
// Each scenario reuses a small, fixed pool of API keys across many virtual
// users on purpose — with a unique key per VU, nobody would ever actually
// hit their limit, and this would just be a throughput test instead of a
// rate-limiter correctness-under-concurrency test. Sharing keys means many
// concurrent requests race to increment/check the same Redis-backed
// counter, which is exactly the scenario that would expose a
// non-atomic ("read, decide, write" instead of one Lua script) bug as
// requests getting allowed that should've been rejected.
//
// Usage:
//   1. Start the gateway + a mock upstream + Redis (see README).
//   2. RATE_LIMIT and RATE_WINDOW_SECONDS below must match the gateway's
//      actual configured values (defaults: 20 requests / 10 seconds).
//   3. k6 run loadtest/compare-algorithms.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.GATEWAY_URL || "http://localhost:8080";
const KEY_POOL_SIZE = 5;

const allowed = new Counter("rate_limit_allowed");
const rejected = new Counter("rate_limit_rejected");

// A 429 here is the gateway working correctly, not a failure — without
// this, k6's default http_req_failed metric treats every non-2xx response
// as an error, which would make "the rate limiter successfully rejected
// excess traffic" look identical to "the gateway is broken."
http.setResponseCallback(http.expectedStatuses(200, 429));

export const options = {
  scenarios: {
    token_bucket: {
      executor: "constant-vus",
      vus: 10,
      duration: "20s",
      exec: "hitTokenBucket",
    },
    sliding_window: {
      executor: "constant-vus",
      vus: 10,
      duration: "20s",
      exec: "hitSlidingWindow",
      startTime: "20s",
    },
    fixed_window: {
      executor: "constant-vus",
      vus: 10,
      duration: "20s",
      exec: "hitFixedWindow",
      startTime: "40s",
    },
  },
  thresholds: {
    // The point isn't "zero rejections" — under this load we expect and
    // want rejections. The point is that the gateway itself never errors.
    http_req_failed: ["rate<0.01"],
  },
};

function keyForVU() {
  return `loadtest-key-${__VU % KEY_POOL_SIZE}`;
}

function hit(path, algorithmLabel) {
  const res = http.get(`${BASE_URL}${path}`, {
    headers: { "X-API-Key": keyForVU() },
    tags: { algorithm: algorithmLabel },
  });
  check(res, {
    "status is 200 or 429": (r) => r.status === 200 || r.status === 429,
  });
  if (res.status === 200) allowed.add(1, { algorithm: algorithmLabel });
  else if (res.status === 429) rejected.add(1, { algorithm: algorithmLabel });
  sleep(0.05);
}

export function hitTokenBucket() {
  hit("/api/tb/loadtest", "token-bucket");
}

export function hitSlidingWindow() {
  hit("/api/sw/loadtest", "sliding-window");
}

export function hitFixedWindow() {
  hit("/api/fw/loadtest", "fixed-window");
}
