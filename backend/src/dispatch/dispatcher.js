import { query, withTx } from '../db/pool.js';
import { redis, keys } from '../lib/redis.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { rankCandidates } from './scoring.js';
import { claimDue, enqueueDispatch, finishDispatch } from './queue.js';
import { syncDriverMirror } from '../services/driverService.js';
import { getOrderRow } from '../services/orderService.js';
import { emitOrderUpdate, emitTo, rooms } from '../realtime/emitter.js';
import { dispatchLatency, dispatchOutcomes } from '../lib/metrics.js';

const DISPATCHABLE = ['ACCEPTED', 'PREPARING', 'READY'];
const CLAIM_TRIES = 3;

/** Find drivers near the restaurant, widening the ring until someone qualifies. */
async function findCandidates(lat, lng, excluded) {
  for (const radiusKm of config.dispatch.radiiKm) {
    const hits = await redis.geosearch(
      keys.driversGeo, 'FROMLONLAT', lng, lat, 'BYRADIUS', radiusKm, 'km',
      'ASC', 'COUNT', config.dispatch.candidateLimit, 'WITHDIST',
    );
    if (!hits.length) continue;
    const pipe = redis.pipeline();
    for (const [id] of hits) pipe.hgetall(keys.driver(id));
    const states = await pipe.exec();
    const candidates = hits
      .map(([id, distKm], i) => {
        const s = states[i][1] || {};
        return {
          driverId: Number(id),
          distanceM: Number(distKm) * 1000,
          status: s.status,
          active: Number(s.active || 0),
          max: Number(s.max || 0),
          vehicle: s.vehicle || 'BIKE',
          lastAssignedAt: Number(s.lastAssignedAt || 0),
        };
      })
      .filter((c) => !excluded.has(String(c.driverId)));
    const eligible = candidates.filter((c) => c.status === 'ONLINE' && c.active < c.max);
    if (eligible.length) return { radiusKm, candidates: eligible, scanned: hits.length };
  }
  return { radiusKm: config.dispatch.radiiKm.at(-1), candidates: [], scanned: 0 };
}

/**
 * Claim = the only place a driver gets a slot. Both guards live in SQL:
 *   drivers: active_orders < max_orders AND status='ONLINE'   (capacity, can't over-assign)
 *   orders:  driver_id IS NULL AND status still dispatchable  (no double-assign, not cancelled)
 * If either guard fails the transaction rolls back and we try the next-best driver.
 */
async function claim(orderId, driverId) {
  return withTx(async (db) => {
    const { rows: [d] } = await db.query(
      `UPDATE drivers SET active_orders = active_orders + 1, last_assigned_at = now()
        WHERE id=$1 AND status='ONLINE' AND active_orders < max_orders
        RETURNING id`,
      [driverId],
    );
    if (!d) return 'DRIVER_TAKEN';
    const { rows: [o] } = await db.query(
      `UPDATE orders SET driver_id=$2, dispatch_state='ASSIGNED', assigned_at=now(), version=version+1, updated_at=now()
        WHERE id=$1 AND driver_id IS NULL AND status = ANY($3::order_status[])
        RETURNING id`,
      [orderId, driverId, DISPATCHABLE],
    );
    if (!o) throw Object.assign(new Error('order no longer dispatchable'), { abort: 'ORDER_GONE' });
    return 'OK';
  }).catch((err) => {
    if (err.abort) return err.abort;
    throw err;
  });
}

async function log(entry) {
  await query(
    `INSERT INTO dispatch_log (order_id, driver_id, attempt, radius_km, candidates, score, distance_m, eta_sec, outcome, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [entry.orderId, entry.driverId ?? null, entry.attempt, entry.radiusKm ?? null, entry.candidates ?? 0,
     entry.score ?? null, entry.distanceM ?? null, entry.etaSec ?? null, entry.outcome, entry.latencyMs ?? null],
  ).catch((err) => logger.warn({ err }, 'dispatch_log insert failed'));
}

export async function dispatchOrder(orderId) {
  const started = Date.now();
  // One round trip: bump the attempt counter only if the order still needs a driver.
  const [{ rows: [order] }, excludedList] = await Promise.all([
    query(
      `UPDATE orders o SET dispatch_attempts = o.dispatch_attempts + 1,
              dispatch_state = CASE WHEN o.dispatch_state='PENDING' THEN 'SEARCHING'::dispatch_state ELSE o.dispatch_state END
         FROM restaurants r
        WHERE o.id=$1 AND r.id=o.restaurant_id AND o.driver_id IS NULL AND o.status = ANY($2::order_status[])
        RETURNING o.dispatch_attempts, o.ready_by, r.lat, r.lng`,
      [orderId, DISPATCHABLE],
    ),
    redis.smembers(keys.dispatchExclude(orderId)),
  ]);
  if (!order) {
    await finishDispatch(orderId);
    return { outcome: 'SKIPPED' };
  }
  const attempt = order.dispatch_attempts;

  const excluded = new Set(excludedList);
  const { radiusKm, candidates } = await findCandidates(order.lat, order.lng, excluded);
  const readyInSec = order.ready_by ? Math.max(0, (new Date(order.ready_by) - Date.now()) / 1000) : 900;
  const ranked = rankCandidates(candidates, {
    readyInSec,
    radiusM: radiusKm * 1000,
    weights: config.dispatch.weights,
  });

  for (const best of ranked.slice(0, CLAIM_TRIES)) {
    const res = await claim(orderId, best.driverId);
    if (res === 'OK') {
      // Postgres committed the slot; mirror it into Redis with an O(1) increment
      // rather than re-reading the driver row.
      await redis
        .multi()
        .sadd(keys.driverOrders(best.driverId), orderId)
        .hincrby(keys.driver(best.driverId), 'active', 1)
        .hset(keys.driver(best.driverId), 'lastAssignedAt', Date.now())
        .exec();
      const waitedMs = await finishDispatch(orderId);
      if (waitedMs != null) dispatchLatency.observe(waitedMs / 1000);
      dispatchOutcomes.inc({ outcome: 'ASSIGNED' });
      const [full] = await Promise.all([
        getOrderRow(orderId),
        log({
          orderId, driverId: best.driverId, attempt, radiusKm, candidates: ranked.length,
          score: best.cost, distanceM: best.distanceM, etaSec: best.etaSec, outcome: 'ASSIGNED',
          latencyMs: Date.now() - started,
        }),
      ]);
      emitTo(rooms.driver(best.driverId), 'assignment:new', full);
      emitOrderUpdate(full, 'order:updated');
      return { outcome: 'ASSIGNED', driverId: best.driverId, cost: best.cost, waitedMs };
    }
    dispatchOutcomes.inc({ outcome: res });
    if (res === 'ORDER_GONE') {
      await finishDispatch(orderId);
      return { outcome: res };
    }
    // DRIVER_TAKEN: our Redis view was stale (another worker just took them). Refresh mirror, try next.
    await syncDriverMirror(best.driverId);
  }

  // Nobody available: retry with exponential backoff, give up after maxAttempts.
  if (attempt >= config.dispatch.maxAttempts) {
    await query(`UPDATE orders SET dispatch_state='FAILED' WHERE id=$1 AND driver_id IS NULL`, [orderId]);
    await finishDispatch(orderId);
    dispatchOutcomes.inc({ outcome: 'FAILED' });
    await log({ orderId, attempt, radiusKm, candidates: ranked.length, outcome: 'FAILED', latencyMs: Date.now() - started });
    emitTo(rooms.ops, 'dispatch:failed', { orderId, attempt });
    return { outcome: 'FAILED' };
  }
  const delay = Math.min(config.dispatch.retryBaseMs * 2 ** (attempt - 1), 30000);
  await enqueueDispatch(orderId, delay);
  dispatchOutcomes.inc({ outcome: 'RETRY' });
  await log({ orderId, attempt, radiusKm, candidates: ranked.length, outcome: 'NO_CANDIDATES', latencyMs: Date.now() - started });
  return { outcome: 'RETRY', delay };
}

/** Polling worker. Safe to run N copies; claimDue() is atomic. */
export function startDispatchWorker() {
  let running = true;
  let timer = null;
  const loop = async () => {
    if (!running) return;
    let busy = false;
    try {
      const due = await claimDue(config.dispatch.batchSize);
      busy = due.length === config.dispatch.batchSize;
      await Promise.all(
        due.map((id) =>
          dispatchOrder(id).catch(async (err) => {
            logger.error({ err, orderId: id }, 'dispatch failed, requeueing');
            await enqueueDispatch(id, config.dispatch.retryBaseMs);
          }),
        ),
      );
    } catch (err) {
      logger.error({ err }, 'dispatch loop error');
    }
    if (running) timer = setTimeout(loop, busy ? 0 : config.dispatch.pollMs);
  };
  loop();
  logger.info('dispatch worker started');
  return () => {
    running = false;
    clearTimeout(timer);
  };
}
