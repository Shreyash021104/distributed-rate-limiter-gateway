export interface LimitResult {
  allowed: boolean;
  /** The configured ceiling, echoed back so the middleware can emit RateLimit-Limit. */
  limit: number;
  /** Requests still available right now. */
  remaining: number;
  /** How long before this specific request could succeed. 0 when allowed. */
  retryAfterMs: number;
  /**
   * How long until the quota is fully restored (remaining === limit), which
   * is what the IETF RateLimit-Reset header actually means. It is not the
   * same as retryAfterMs: a client one token short can retry long before its
   * whole budget comes back.
   */
  resetMs: number;
}

export interface Limiter {
  readonly algorithm: "token-bucket" | "sliding-window" | "fixed-window";
  readonly limit: number;
  check(key: string): Promise<LimitResult>;
}
