import { getRedis } from './redis.js';

// Pigeon allows a bucket of 8 sends per workspace, refilling at 4/s. We stay a little under it,
// so normally we never get a 429. The bucket lives in Redis, so all server copies share it.
const CAPACITY = 6;
const REFILL_PER_SEC = 3.5;

// Atomic in Redis (a Lua script runs without interruption). Uses Redis' own clock, so copies
// with slightly different clocks still agree.
// Returns 0 = go ahead (a token was taken), otherwise how many ms to wait.
const TAKE = `
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)

local cool = tonumber(redis.call('GET', KEYS[2]) or '0')
if cool > now then return cool - now end

local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)

local wait = 0
if tokens >= 1 then tokens = tokens - 1 else wait = math.ceil((1 - tokens) / rate * 1000) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], 60000)
return wait
`;

const bucketKey = (ws: string) => `sb:rl:${ws}`;
const coolOffKey = (ws: string) => `sb:cooloff:${ws}`;

export async function takeSendToken(workspace: string): Promise<number> {
  const wait = await getRedis().eval(TAKE, 2, bucketKey(workspace), coolOffKey(workspace), CAPACITY, REFILL_PER_SEC);
  return Number(wait);
}

// After a 429: nobody in this workspace sends until Retry-After has passed (all copies).
// Stored as an absolute time (Redis clock) so the TAKE script can compare it.
const SET_COOLOFF = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local untilMs = now + tonumber(ARGV[1])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if untilMs > cur then redis.call('SET', KEYS[1], untilMs, 'PX', tonumber(ARGV[1]) + 1000) end
return untilMs
`;

export async function startCoolOff(workspace: string, ms: number): Promise<void> {
  // +250 ms margin so we are safely past Pigeon's window
  await getRedis().eval(SET_COOLOFF, 1, coolOffKey(workspace), Math.ceil(ms + 250));
}
