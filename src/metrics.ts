import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

/**
 * Outcome of the rate-limit decision itself.
 * - allowed / rejected: the limiter ran and made a real decision.
 * - failed_open: the limiter could not run (Redis down, slow, or erroring)
 *   and the request was let through unmetered. This is the one that matters
 *   operationally — it means the gateway is currently not enforcing
 *   anything, which nothing else in the system would otherwise reveal.
 */
export const requestsTotal = new client.Counter({
  name: "gateway_requests_total",
  help: "Requests seen by the gateway, labeled by algorithm and rate-limit outcome",
  labelNames: ["algorithm", "outcome"] as const,
  registers: [registry],
});

// Two separate duration metrics, because conflating them hides the thing
// each is good for. The check histogram isolates the Redis round-trip — the
// cost the gateway itself adds — while the request histogram covers the
// whole hop including the upstream. Measuring only the first and calling it
// end-to-end (which this project used to do, by observing before next()
// rather than on response finish) makes the gateway look faster than any
// client actually experiences.
export const limiterCheckDuration = new client.Histogram({
  name: "gateway_limiter_check_duration_seconds",
  help: "Duration of the rate-limit check alone, including the Redis round-trip",
  labelNames: ["algorithm", "outcome"] as const,
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [registry],
});

export const requestDuration = new client.Histogram({
  name: "gateway_request_duration_seconds",
  help: "End-to-end request duration, measured on response finish (limit check + proxy hop)",
  labelNames: ["algorithm", "outcome"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const limiterErrorsTotal = new client.Counter({
  name: "gateway_limiter_errors_total",
  help: "Rate-limit checks that failed and fell through unenforced, by failure reason",
  labelNames: ["algorithm", "reason"] as const,
  registers: [registry],
});

export const upstreamErrorsTotal = new client.Counter({
  name: "gateway_upstream_errors_total",
  help: "Requests that passed the rate limit but failed while being proxied upstream",
  labelNames: ["algorithm", "code"] as const,
  registers: [registry],
});
