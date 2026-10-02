import crypto from 'node:crypto';
import { redis, keys } from '../lib/redis.js';
import { config } from '../config.js';
import { AppError, badRequest } from '../lib/errors.js';
import { idempotentReplays } from '../lib/metrics.js';

const fingerprint = (body) => crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');

/**
 * Idempotency-Key middleware (same contract Stripe uses).
 *
 *  1. First request with a key: SET NX a short-lived IN_PROGRESS lock, run the handler,
 *     then overwrite the key with the final {status, body} for 24h.
 *  2. Retry after completion: replay the stored response, handler never runs again.
 *  3. Retry while the first is still running: 409 so the client backs off.
 *  4. Same key, different payload: 422, because that's a client bug, not a retry.
 *  5. Handler crashed (5xx): delete the key so the client can safely retry.
 *
 * The DB also has UNIQUE(customer_id, idempotency_key) as a backstop if Redis loses the key.
 */
export function idempotent(scope) {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key) return next(badRequest('Idempotency-Key header is required'));
    if (key.length > 128) return next(badRequest('Idempotency-Key too long'));

    const redisKey = keys.idem(`${scope}:${req.user.id}`, key);
    const fp = fingerprint(req.body);
    req.idempotencyKey = key;

    const acquired = await redis.set(
      redisKey,
      JSON.stringify({ state: 'IN_PROGRESS', fp }),
      'EX',
      config.idempotency.lockTtlSec,
      'NX',
    );

    if (!acquired) {
      const raw = await redis.get(redisKey);
      if (!raw) return next(new AppError(409, 'RETRY', 'Please retry'));
      const saved = JSON.parse(raw);
      if (saved.fp !== fp) {
        return next(new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different payload'));
      }
      if (saved.state === 'IN_PROGRESS') {
        res.set('Retry-After', '1');
        return next(new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is in progress'));
      }
      idempotentReplays.inc();
      res.set('Idempotent-Replayed', 'true');
      return res.status(saved.status).json(saved.body);
    }

    // Capture the response so we can persist it.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const done =
        status >= 500
          ? redis.del(redisKey)
          : redis.set(redisKey, JSON.stringify({ state: 'DONE', fp, status, body }), 'EX', config.idempotency.ttlSec);
      done.catch(() => {});
      return originalJson(body);
    };
    next();
  };
}
