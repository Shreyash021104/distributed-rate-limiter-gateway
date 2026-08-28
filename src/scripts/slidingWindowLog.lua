-- Sliding window log rate limiter, using a Redis sorted set as the "log."
--
-- KEYS[1] = log key (e.g. "sw:{apiKey}")
-- ARGV[1] = window_ms (window size in milliseconds)
-- ARGV[2] = limit (max requests allowed in the window)
-- ARGV[3] = now (current time in milliseconds)
-- ARGV[4] = member (a unique id for this request, so concurrent requests in
--           the same millisecond don't collide as the same sorted-set member)
--
-- Returns: {allowed (0/1), count_in_window, retry_after_ms, reset_ms}
--
-- Unlike fixed windows, this is exact: it tracks the actual timestamp of
-- every request in the current window (as sorted-set members scored by
-- their timestamp), evicts anything older than the window on every call,
-- then counts what's left. No boundary bursting is possible because there's
-- no fixed boundary — the window is always "now minus window_ms", evaluated
-- fresh on every request. The cost is memory: one sorted-set entry per
-- request in the window, vs. a single integer for fixed/token-bucket.

local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, 0, now - window_ms)
local count = redis.call("ZCARD", key)

local allowed = 0
local retry_after_ms = 0

if count < limit then
  redis.call("ZADD", key, now, member)
  allowed = 1
  count = count + 1
else
  -- A slot frees up the moment the *oldest* entry ages out of the window, so
  -- that's the honest retry time. Returning the full window instead (the
  -- obvious shortcut) tells a client to wait the maximum every time, even
  -- when it was one millisecond away from a free slot — a limiter that
  -- over-states its retry time trains clients to back off far more than they
  -- need to, which shows up as wasted capacity rather than as a bug.
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  if oldest[2] then
    retry_after_ms = math.max(0, (tonumber(oldest[2]) + window_ms) - now)
  else
    retry_after_ms = window_ms
  end
end

-- Full quota is only restored once the *newest* entry ages out, since every
-- entry still in the log is holding a slot until then.
local reset_ms = 0
if count > 0 then
  local newest = redis.call("ZRANGE", key, -1, -1, "WITHSCORES")
  if newest[2] then
    reset_ms = math.max(0, (tonumber(newest[2]) + window_ms) - now)
  end
end

redis.call("PEXPIRE", key, window_ms)

return { allowed, count, retry_after_ms, reset_ms }
