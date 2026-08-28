import type { Request, Response, NextFunction } from "express";
import type { Limiter } from "./limiters/types.js";
import {
  requestsTotal,
  requestDuration,
  limiterCheckDuration,
  limiterErrorsTotal,
} from "./metrics.js";

// Requests are keyed by API key when present, falling back to client IP.
// In production you'd require the API key and reject anonymous traffic
// outright; falling back to IP here just means the demo works out of the
// box without a client sending credentials.
//
// The IP path is only trustworthy if `trust proxy` is configured to match
// the real deployment (see env.ts) — behind a load balancer with the default
// setting, req.ip is the balancer's address and every anonymous client in
// the world lands in one shared bucket.
function clientKey(req: Request): string {
  const apiKey = req.header("x-api-key");
  return apiKey ? `key:${apiKey}` : `ip:${req.ip}`;
}

// Which flavor of Redis failure caused a fail-open. Worth splitting: a
// timeout means Redis is up but too slow to sit in the request path, while
// unavailable means it's gone entirely. Those call for different responses
// during an incident, and a single "errors" counter can't tell them apart.
function failureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed? out/i.test(message)) return "timeout";
  if (/enableOfflineQueue|Connection is closed|ECONNREFUSED|Stream isn't writeable/i.test(message)) {
    return "unavailable";
  }
  return "other";
}

export function rateLimitMiddleware(limiter: Limiter) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const key = clientKey(req);
    const elapsedSeconds = () => Number(process.hrtime.bigint() - start) / 1e9;

    let result;
    let outcome: "allowed" | "rejected" | "failed_open";
    try {
      result = await limiter.check(key);
      outcome = result.allowed ? "allowed" : "rejected";
    } catch (err) {
      // If the limiter can't reach Redis, fail open rather than taking the
      // whole gateway down with it — a rate limiter that's temporarily too
      // permissive is a much smaller incident than the gateway 500ing on
      // every request because its dependency hiccuped.
      //
      // The part that makes this real rather than aspirational is that the
      // failure arrives in milliseconds (see the client options in
      // redis.ts), and that it's counted here. An uncounted fail-open is
      // arguably worse than a hard failure: the gateway silently stops
      // enforcing limits and every dashboard still shows green.
      outcome = "failed_open";
      const reason = failureReason(err);
      limiterErrorsTotal.inc({ algorithm: limiter.algorithm, reason });
      requestsTotal.inc({ algorithm: limiter.algorithm, outcome });
      limiterCheckDuration.observe({ algorithm: limiter.algorithm, outcome }, elapsedSeconds());
      observeOnFinish(res, limiter.algorithm, outcome, start);
      console.error(`[${limiter.algorithm}] limiter check failed (${reason}), failing open:`, err);
      res.setHeader("X-RateLimit-Enforced", "false");
      next();
      return;
    }

    requestsTotal.inc({ algorithm: limiter.algorithm, outcome });
    limiterCheckDuration.observe({ algorithm: limiter.algorithm, outcome }, elapsedSeconds());
    observeOnFinish(res, limiter.algorithm, outcome, start);

    // Both the IETF draft names (RateLimit-*) and the de-facto legacy ones
    // (X-RateLimit-*) — clients in the wild read either, and emitting only
    // Remaining, as this did before, leaves a caller unable to work out what
    // it's remaining *out of* or when it gets its budget back.
    const resetSeconds = Math.ceil(result.resetMs / 1000);
    const remaining = Math.max(0, Math.floor(result.remaining));
    res.setHeader("RateLimit-Limit", String(result.limit));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetSeconds));
    res.setHeader("X-RateLimit-Algorithm", limiter.algorithm);

    if (!result.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json({
        error: "Too Many Requests",
        algorithm: limiter.algorithm,
        retryAfterMs: result.retryAfterMs,
      });
      return;
    }

    next();
  };
}

// End-to-end timing has to be taken when the response actually finishes,
// which for an allowed request is after the proxy has round-tripped the
// upstream. `close` covers clients that hang up mid-response, so aborted
// requests don't silently vanish from the histogram.
function observeOnFinish(
  res: Response,
  algorithm: string,
  outcome: string,
  start: bigint
): void {
  let observed = false;
  const record = () => {
    if (observed) return;
    observed = true;
    requestDuration.observe(
      { algorithm, outcome },
      Number(process.hrtime.bigint() - start) / 1e9
    );
  };
  res.on("finish", record);
  res.on("close", record);
}
