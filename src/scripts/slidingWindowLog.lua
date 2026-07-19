-- Sliding window log rate limiter, using a Redis sorted set as the "log."
--
-- KEYS[1] = log key (e.g. "sw:{apiKey}")
-- ARGV[1] = window_ms (window size in milliseconds)
-- ARGV[2] = limit (max requests allowed in the window)
-- ARGV[3] = now (current time in milliseconds)
-- ARGV[4] = member (a unique id for this request, so concurrent requests in
--           the same millisecond don't collide as the same sorted-set member)
--
-- Returns: {allowed (0/1), count_in_window}
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
if count < limit then
  redis.call("ZADD", key, now, member)
  allowed = 1
  count = count + 1
end

redis.call("PEXPIRE", key, window_ms)

return { allowed, count }
