import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const requestsTotal = new client.Counter({
  name: "gateway_requests_total",
  help: "Total requests seen by the gateway, labeled by algorithm and outcome",
  labelNames: ["algorithm", "outcome"] as const,
  registers: [registry],
});

export const requestDuration = new client.Histogram({
  name: "gateway_request_duration_seconds",
  help: "End-to-end request duration including the rate-limit check and proxying",
  labelNames: ["algorithm", "outcome"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});
