export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface Limiter {
  readonly algorithm: "token-bucket" | "sliding-window" | "fixed-window";
  check(key: string): Promise<LimitResult>;
}
