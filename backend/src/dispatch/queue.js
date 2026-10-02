import { redis, keys } from '../lib/redis.js';

/**
 * Dispatch queue = Redis sorted set (member: orderId, score: due-at ms).
 * Delayed retries are just a later score. Several workers can poll the same set
 * because claimDue() pops atomically in a Lua script, so each order is handed
 * to exactly one worker per attempt.
 */
const ENQUEUED_AT = 'dispatch:enqueued_at'; // HASH orderId -> first enqueue time (for latency metric)

const CLAIM_DUE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
if #due > 0 then redis.call('ZREM', KEYS[1], unpack(due)) end
return due`;

export async function enqueueDispatch(orderId, delayMs = 0) {
  const now = Date.now();
  await redis
    .multi()
    .zadd(keys.dispatchQueue, now + delayMs, orderId)
    .hsetnx(ENQUEUED_AT, orderId, String(now))
    .exec();
}

export async function claimDue(limit) {
  return redis.eval(CLAIM_DUE, 1, keys.dispatchQueue, Date.now(), limit);
}

export async function cancelDispatch(orderId) {
  await redis.multi().zrem(keys.dispatchQueue, orderId).hdel(ENQUEUED_AT, orderId).exec();
}

/** Returns ms since first enqueue and clears the marker. */
export async function finishDispatch(orderId) {
  const [[, t]] = await redis.multi().hget(ENQUEUED_AT, orderId).hdel(ENQUEUED_AT, orderId).exec();
  return t ? Date.now() - Number(t) : null;
}

export const queueDepth = () => redis.zcard(keys.dispatchQueue);
