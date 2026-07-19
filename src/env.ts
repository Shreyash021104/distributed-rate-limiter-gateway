import "dotenv/config";

export const env = {
  port: Number(process.env.PORT ?? 8080),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  upstreamUrl: process.env.UPSTREAM_URL ?? "http://localhost:9000",
  mockUpstreamPort: Number(process.env.MOCK_UPSTREAM_PORT ?? 9000),

  // Shared limit config: N requests per WINDOW_SECONDS, applied identically
  // across all three algorithms so their behavior under the same load is
  // directly comparable.
  limit: Number(process.env.RATE_LIMIT ?? 20),
  windowSeconds: Number(process.env.RATE_WINDOW_SECONDS ?? 10),

  instanceId: process.env.INSTANCE_ID ?? `instance-${process.pid}`,
};
