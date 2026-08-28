import "dotenv/config";

// Configuration is validated at boot rather than coerced lazily at the call
// site. `Number(process.env.RATE_LIMIT)` on a typo silently yields NaN, and
// every subsequent `count <= NaN` comparison is false — meaning a one
// character mistake in an env var turns the gateway into a service that
// rejects 100% of traffic, with nothing in the logs explaining why. Failing
// loudly at startup is strictly better than failing quietly under load.

class ConfigError extends Error {}

const problems: string[] = [];

function required(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function num(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    problems.push(`${name}="${raw}" is not a number`);
    return fallback;
  }
  if (opts.min !== undefined && parsed < opts.min) {
    problems.push(`${name}=${parsed} must be >= ${opts.min}`);
    return fallback;
  }
  if (opts.max !== undefined && parsed > opts.max) {
    problems.push(`${name}=${parsed} must be <= ${opts.max}`);
    return fallback;
  }
  return parsed;
}

function url(name: string, fallback: string, protocols: string[]): string {
  const raw = required(name, fallback);
  try {
    const parsed = new URL(raw);
    if (!protocols.includes(parsed.protocol.replace(":", ""))) {
      problems.push(`${name}="${raw}" must use one of: ${protocols.join(", ")}`);
    }
  } catch {
    problems.push(`${name}="${raw}" is not a valid URL`);
  }
  return raw;
}

// Express's `trust proxy` setting, which decides what `req.ip` resolves to.
// This matters more than it looks: the rate limiter falls back to keying on
// IP when no API key is present, and behind a load balancer (Render, nginx,
// an ALB) the socket's remote address is the *proxy's* IP for every single
// client. Left at the default, every anonymous caller in the world shares
// one bucket. Set to the number of proxy hops in front of the gateway so
// Express reads the correct entry from X-Forwarded-For — not to `true`,
// which trusts the whole header and lets a client spoof its way into a
// fresh bucket per request by prepending a fake address.
function trustProxySetting(): boolean | number {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === "") return false;
  if (raw === "false") return false;
  if (raw === "true") {
    problems.push(
      `TRUST_PROXY="true" trusts the entire X-Forwarded-For chain, which lets clients spoof ` +
        `their IP and bypass IP-keyed limits. Set it to the number of proxy hops instead (e.g. 1).`
    );
    return false;
  }
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    problems.push(`TRUST_PROXY="${raw}" must be a non-negative integer (proxy hop count) or "false"`);
    return false;
  }
  return hops;
}

const parsed = {
  port: num("PORT", 8080, { min: 1, max: 65535 }),
  redisUrl: url("REDIS_URL", "redis://localhost:6379", ["redis", "rediss"]),
  upstreamUrl: url("UPSTREAM_URL", "http://localhost:9000", ["http", "https"]),
  mockUpstreamPort: num("MOCK_UPSTREAM_PORT", 9000, { min: 1, max: 65535 }),

  // Shared limit config: N requests per WINDOW_SECONDS, applied identically
  // across all three algorithms so their behavior under the same load is
  // directly comparable.
  limit: num("RATE_LIMIT", 20, { min: 1 }),
  windowSeconds: num("RATE_WINDOW_SECONDS", 10, { min: 1 }),

  trustProxy: trustProxySetting(),

  // How long a single Redis command may take before it's abandoned and the
  // request fails open. Deliberately short: the limiter sits in the hot path
  // of every request, so a Redis that's up but slow must not become the
  // gateway's own latency. See src/redis.ts for the full reasoning.
  redisCommandTimeoutMs: num("REDIS_COMMAND_TIMEOUT_MS", 250, { min: 10 }),
  redisConnectTimeoutMs: num("REDIS_CONNECT_TIMEOUT_MS", 1000, { min: 50 }),

  // How long to let in-flight requests finish on SIGTERM before forcing exit.
  shutdownGraceMs: num("SHUTDOWN_GRACE_MS", 10_000, { min: 0 }),

  instanceId: required("INSTANCE_ID", `instance-${process.pid}`),
};

if (problems.length > 0) {
  throw new ConfigError(
    `Invalid configuration:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\nSee .env.example for the expected values.`
  );
}

export const env = parsed;
