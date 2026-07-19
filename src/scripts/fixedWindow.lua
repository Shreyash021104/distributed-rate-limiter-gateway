-- Fixed window counter rate limiter.
--
-- KEYS[1] = counter key, already bucketed by window number by the caller
--           (e.g. "fw:{apiKey}:{floor(now / window_seconds)}") so the key
--           itself naturally changes when the window rolls over — no
--           explicit "reset" logic needed.
-- ARGV[1] = limit (max requests allowed in this window)
-- ARGV[2] = window_seconds (used only to set the key's TTL)
--
-- Returns: {allowed (0/1), count_in_window}
--
-- This is the cheapest of the three (one INCR, no timestamp bookkeeping),
-- and the trade-off is the classic "boundary burst" problem: a client can
-- send `limit` requests in the last millisecond of one window and another
-- `limit` in the first millisecond of the next, getting 2x the intended
-- rate over that two-millisecond span. Sliding window log doesn't have this
-- gap; fixed window is here specifically so that gap can be demonstrated
-- and measured in the load-test comparison, not hidden.

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])

local count = redis.call("INCR", key)
if count == 1 then
  redis.call("EXPIRE", key, window_seconds)
end

local allowed = 0
if count <= limit then
  allowed = 1
end

return { allowed, count }
