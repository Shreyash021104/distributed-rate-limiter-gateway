-- Token bucket rate limiter.
--
-- KEYS[1] = bucket key (e.g. "tb:{apiKey}")
-- ARGV[1] = capacity (max tokens the bucket can hold)
-- ARGV[2] = refill_rate (tokens added per second)
-- ARGV[3] = now (current time in milliseconds)
-- ARGV[4] = requested (tokens this request costs, normally 1)
--
-- Returns: {allowed (0/1), tokens_remaining, retry_after_ms}
--
-- Everything below runs as a single atomic operation on the Redis server —
-- that's the entire point. A naive client-side implementation would GET the
-- current token count, decide locally whether to allow the request, then
-- SET the new count. Between the GET and the SET, a second request (from
-- this same gateway instance, or a different one behind the same load
-- balancer) can read the same stale count and also decide to allow itself
-- through, letting two requests spend the same token. Running the whole
-- read-decide-write sequence inside Redis as one Lua script closes that gap
-- completely: Redis executes Lua scripts single-threaded, so no other
-- command (including another invocation of this same script) can interleave
-- with it.

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(bucket[1])
local last_ts = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  last_ts = now
end

local elapsed_seconds = math.max(0, now - last_ts) / 1000
tokens = math.min(capacity, tokens + elapsed_seconds * refill_rate)

local allowed = 0
local retry_after_ms = 0

if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  local deficit = requested - tokens
  retry_after_ms = math.ceil((deficit / refill_rate) * 1000)
end

redis.call("HMSET", key, "tokens", tokens, "ts", now)
-- Let the key expire on its own once the bucket would be fully idle for a
-- while, so we don't accumulate keys for API keys that stop sending traffic.
redis.call("PEXPIRE", key, math.ceil((capacity / refill_rate) * 1000) + 1000)

return { allowed, tostring(tokens), retry_after_ms }
