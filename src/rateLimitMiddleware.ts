import type { Request, Response, NextFunction } from "express";
import type { Limiter } from "./limiters/types.js";
import { requestsTotal, requestDuration } from "./metrics.js";

// Requests are keyed by API key when present, falling back to client IP.
// In production you'd require the API key and reject anonymous traffic
// outright; falling back to IP here just means the demo works out of the
// box without a client sending credentials.
function clientKey(req: Request): string {
  const apiKey = req.header("x-api-key");
  return apiKey ? `key:${apiKey}` : `ip:${req.ip}`;
}

export function rateLimitMiddleware(limiter: Limiter) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const key = clientKey(req);

    let result;
    try {
      result = await limiter.check(key);
    } catch (err) {
      // If Redis is unreachable, fail open rather than taking the whole
      // gateway down with it — a rate limiter that's temporarily too
      // permissive is a much smaller incident than the gateway 500ing on
      // every request because its dependency hiccuped.
      console.error(`[${limiter.algorithm}] limiter check failed, failing open:`, err);
      next();
      return;
    }

    const outcome = result.allowed ? "allowed" : "rejected";
    const observe = () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      requestsTotal.inc({ algorithm: limiter.algorithm, outcome });
      requestDuration.observe({ algorithm: limiter.algorithm, outcome }, seconds);
    };

    res.setHeader("X-RateLimit-Algorithm", limiter.algorithm);
    res.setHeader("X-RateLimit-Remaining", String(Math.floor(result.remaining)));

    if (!result.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      observe();
      res.status(429).json({
        error: "Too Many Requests",
        algorithm: limiter.algorithm,
        retryAfterMs: result.retryAfterMs,
      });
      return;
    }

    observe();
    next();
  };
}
