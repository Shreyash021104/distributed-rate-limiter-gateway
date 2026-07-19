# Distributed Rate Limiter & API Gateway

A standalone gateway that sits in front of any backend, enforcing per-client rate
limits correctly even when the gateway itself is scaled to multiple instances behind
a load balancer — which is exactly the case a naive rate limiter gets wrong.

**Live demo:** https://rate-limiter-gateway-bgb7.onrender.com (gateway) proxying to
https://rate-limiter-mock-upstream.onrender.com (mock upstream), both on Render's
free tier — see the cold-start caveat in [Deployment](#deployment). Try it:

```bash
curl -i https://rate-limiter-gateway-bgb7.onrender.com/api/fw/hello -H "X-API-Key: demo"
```

Send it 21+ times in a row (`for i in {1..25}; do curl -s -o /dev/null -w "%{http_code} " ...; done`)
and watch it start returning `429` after the 20th.

## The problem

Every rate limiter tutorial shows you a single in-memory counter: a request comes in,
you check a number, you increment it. That works exactly once — on a single process.
The moment you run two instances of the gateway behind a load balancer (which is the
normal, expected shape of "a gateway" in production), each instance has its own
independent copy of that counter. A client that's supposed to be capped at 20
requests per 10 seconds gets 20 *per instance* — 60 requests if there are three
instances, without ever technically exceeding what any single instance "saw." The bug
isn't in the counting logic; it's in where the counter lives.

The fix is to move the counter somewhere every instance shares — Redis — and to make
each check-and-increment a single atomic operation there, so concurrent requests from
different gateway instances can never race each other into an inconsistent count.

## Architecture

```
 Incoming request (X-API-Key: abc123)
            │
            ▼
 ┌─────────────────────────────┐
 │  Gateway instance (any one)  │
 │  1. Extract key from header  │
 │  2. Run rate-limit Lua script │───────▶ Redis (atomic INCR/HMSET/
 │     atomically on Redis      │          ZADD via EVALSHA — every
 │  3. Allow → proxy to upstream │         gateway instance evaluates
 │     Deny  → 429 + Retry-After│          the SAME script against the
 └──────────────┬───────────────┘         SAME keys, so state is
                │                          consistent no matter which
                ▼                          instance handled the request)
        Mock upstream service
        (stand-in for "the real backend")

 Prometheus scrapes /metrics on every instance ──▶ Grafana dashboard
```

Three algorithms are implemented and mounted **simultaneously**, each behind its own
path prefix, all enforcing the identical configured limit:

| Route | Algorithm | Redis structure |
|---|---|---|
| `/api/tb/*` | Token bucket | Hash: `{tokens, last_refill_ts}` |
| `/api/sw/*` | Sliding window log | Sorted set: member per request, scored by timestamp |
| `/api/fw/*` | Fixed window counter | Simple integer, keyed by `{apiKey}:{windowBucket}` |

Mounting all three at once — instead of picking one — is deliberate: it means the
exact same load-test traffic pattern can hit all three back to back and produce a
real, apples-to-apples comparison instead of three separate, hard-to-compare runs.

## Tech stack

| Layer | Choice |
|---|---|
| Gateway | Node.js + TypeScript + Express |
| Rate limit store | Redis, atomic counters via Lua scripts (`EVALSHA`, cached automatically by `ioredis`'s `defineCommand`) |
| Algorithms | Token bucket, sliding window log, fixed window counter — all three, benchmarked against each other |
| Routing/proxy | `http-proxy-middleware` (Node's `http` under the hood, same idea as `httputil.ReverseProxy`) |
| Observability | `prom-client` exposing request counts/latency histograms per algorithm; Grafana on top |
| Load testing | k6, with a custom scenario per algorithm sharing a small API-key pool to force real contention |
| Deployment | Docker Compose locally (two gateway replicas + Redis + mock upstream + Prometheus + Grafana); Render in production |

## The hardest decisions

### 1. Atomicity is the entire project — everything else is plumbing

The failure mode this project exists to prevent: gateway instance A does `GET
counter` (reads 19), gateway instance B does `GET counter` (also reads 19, a moment
later but before A writes back), both decide "19 < 20, allow it," both do `SET
counter 20`. Two requests just got allowed on what should have been the 20th and
last slot — the classic **check-then-act race condition**, and it happens *between*
two separate machines, so no amount of in-process locking fixes it.

The fix isn't "use a fancier data structure" — it's moving the entire
read-decide-write sequence into a single Lua script that Redis runs to completion,
uninterrupted, before processing any other command (including another invocation of
the same script from a different gateway instance). See `src/scripts/tokenBucket.lua`
— the comment at the top of that file spells out exactly why the naive version
breaks. `scripts/multi-instance-test.mjs` proves the fix: it spins up two real
gateway processes on different ports sharing one Redis, fires 3x the configured limit
worth of requests alternating between them with the same API key, and asserts the
total allowed across *both instances combined* equals the limit — not double it.
That test passing is the actual deliverable of this project; everything else is
scaffolding around it.

### 2. Fixed window's boundary burst isn't a bug — it's a documented, measured trade-off

Fixed window counters reset on a clock boundary (e.g., every 10 seconds, on the
10-second mark). A client can send `limit` requests in the last millisecond of one
window and another `limit` in the first millisecond of the next — two allowed bursts,
milliseconds apart, adding up to 2x the intended rate over that span. This is a
known, named weakness of the algorithm, not an implementation bug, and I didn't want
to just assert that in a comment — `scripts/boundary-burst-test.mjs` reproduces it on
purpose: it aligns requests to land right at a real window boundary, fires a full
`limit` batch on each side of it, and measures the result. On my machine: **fixed
window allowed 10 requests against a configured limit of 5** (exactly the 2x burst),
while **sliding window log, given the identical timing pattern, correctly held at 5**
— because it has no fixed boundary to exploit; it always looks back exactly `window`
milliseconds from *now*. That's the actual trade-off, measured, not just described.

The cost sliding window pays for that correctness: memory. It stores one sorted-set
entry per request in the trailing window, vs. fixed window's single integer. For a
high-limit, high-traffic key, that's a real difference worth knowing before picking
one in an interview — "sliding window is strictly better" isn't the right answer;
"sliding window is more correct at the boundary but costs O(requests-in-window)
memory instead of O(1)" is.

### 3. Fail open, not closed, when Redis is unreachable

If the Redis call in the rate-limit check throws (network blip, Redis restart), the
gateway logs the error and lets the request through rather than returning a 500 (see
`rateLimitMiddleware.ts`). The reasoning: a rate limiter that's briefly *too
permissive* during an infrastructure hiccup is a minor, self-correcting problem. A
gateway that takes its *entire upstream* down because its rate-limit dependency
sneezed is a much bigger incident, and defeats half the purpose of putting a gateway
in front of the backend in the first place (protecting it from becoming
unreachable). This is a real trade-off, not a free choice — a security-sensitive
endpoint (login attempts, for instance) might reasonably want the opposite: fail
closed, and reject rather than risk unlimited unauthenticated traffic during an
outage. Worth stating which one you picked and why, in an interview, rather than
letting it be an accident.

## Verifying it yourself

Three scripts exercise the actual running gateway — not mocks — and each one spins up
its own throwaway gateway/upstream processes on dedicated ports so it can't collide
with anything else you have running:

```bash
npm run test:multi-instance    # two gateway instances, one Redis: proves the shared limit holds
npm run test:boundary-burst    # measures fixed window's boundary burst vs sliding window's lack of one
```

And the k6 load test, which needs a gateway actually running first:

```bash
npm run dev &          # gateway on :8080
npm run mock-upstream & # upstream on :9000
k6 run loadtest/compare-algorithms.js
```

Real numbers from a local run (limit=5/10s, 10 VUs per algorithm for 20s each, 5
shared API keys to force contention): **175 requests allowed, 10,906 correctly
rejected, 0% actual failure rate** (every response was a valid 200 or 429 — the 429s
are the rate limiter working, not the gateway breaking), p95 latency 8.6ms including
the Redis round-trip and proxy hop.

## Running locally

Requires Redis (`brew install redis && brew services start redis`, or `docker compose
up -d redis`).

```bash
cp .env.example .env
npm install
npm run mock-upstream    # terminal 1 — the backend being protected, on :9000
npm run dev               # terminal 2 — the gateway, on :8080

curl http://localhost:8080/api/tb/hello -H "X-API-Key: demo"   # token bucket
curl http://localhost:8080/api/sw/hello -H "X-API-Key: demo"   # sliding window
curl http://localhost:8080/api/fw/hello -H "X-API-Key: demo"   # fixed window
curl http://localhost:8080/metrics                              # Prometheus format
```

## What I'd change at 10x scale

- **No per-endpoint or per-tier limits.** Every API key gets the same limit today
  (`RATE_LIMIT`/`RATE_WINDOW_SECONDS`, global). A real gateway needs per-route limits
  (a search endpoint and a health check shouldn't share a budget) and per-plan limits
  (free tier vs. paid tier) — both are a config/lookup layer on top of the same
  atomic-script foundation, not a rework of it.
- **Fail-open is a global policy today; it should be a per-route choice** (see
  decision #3) — auth endpoints and payment endpoints likely want fail-closed even
  though the general API doesn't.
- **No distributed tracing.** Prometheus metrics show *that* the gateway is
  rejecting a spike, not which upstream call chain triggered it. Wiring in
  OpenTelemetry (same pattern as the event-driven order system project) would close
  that gap.
- **Single Redis instance is a single point of failure.** At real scale this needs
  Redis Cluster or a managed equivalent (ElastiCache, Upstash) with the gateway's
  Lua scripts confirmed to work against a clustered keyspace (cross-slot operations
  need care — each of these scripts only ever touches one key, which keeps them
  cluster-safe as written, but that constraint would need to stay enforced
  deliberately as the scripts evolve).

## Deployment

**What's actually running:** two separate Render free web services — `rate-limiter-gateway`
and `rate-limiter-mock-upstream` — both deployed from this repo's `main` branch, plus
a shared free-tier Redis instance (reused from another one of my projects; its key
namespace here — `tb:*`/`sw:*`/`fw:*` — doesn't collide with anything else using that
instance). `RATE_LIMIT`, `RATE_WINDOW_SECONDS`, `REDIS_URL`, `UPSTREAM_URL` are set as
Render environment variables — see `.env.example` for the full list.

**Known trade-off of the free-tier deployment:** Render's free web services spin down
after 15 minutes idle; the first request after that takes ~30-50s to cold-start. If
the curl command above hangs for a bit on your first try, that's why — not a bug.
The gateway's own rate limiting is unaffected either way, since it's enforced in
Redis, not in the gateway process's memory.

**To deploy your own copy:** provision Redis, deploy `src/mockUpstream.ts` (or your
own real backend) as one service, deploy the gateway as a second long-lived Node
process pointed at it via `UPSTREAM_URL`, and you're done — no database, no
migrations, just the one Redis dependency.

**Locally**, `docker-compose.yml` runs the full picture: two gateway replicas
(`gateway-a`, `gateway-b`) sharing one Redis, a mock upstream, Prometheus scraping
both replicas, and Grafana on top — `docker compose up` reproduces the multi-instance
story from decision #1 as an actual running system, not just a test script.

## License

MIT
