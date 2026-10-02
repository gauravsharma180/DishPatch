import { redis, keys } from '../lib/redis.js';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { notFound, badRequest } from '../lib/errors.js';
import { emitTo, rooms } from '../realtime/emitter.js';
import { logger } from '../lib/logger.js';

/**
 * Postgres is the source of truth for driver capacity (active_orders <= max_orders,
 * enforced by a CHECK constraint). Redis holds a fast-moving mirror:
 *   - geo:drivers    GEO index of online drivers, updated on every GPS ping
 *   - driver:{id}    HASH with status/active/max/vehicle for candidate filtering
 * The mirror may be briefly stale; the dispatcher's claim step re-validates in Postgres.
 */

export async function syncDriverMirror(driverId) {
  const { rows: [d] } = await query(
    'SELECT id, status, lat, lng, active_orders, max_orders, vehicle, last_assigned_at FROM drivers WHERE id=$1',
    [driverId],
  );
  if (!d) return null;
  const pipe = redis.multi();
  pipe.hset(keys.driver(d.id), {
    status: d.status,
    active: d.active_orders,
    max: d.max_orders,
    vehicle: d.vehicle,
    lastAssignedAt: d.last_assigned_at ? new Date(d.last_assigned_at).getTime() : 0,
  });
  if (d.status === 'ONLINE' && d.lat != null) pipe.geoadd(keys.driversGeo, d.lng, d.lat, String(d.id));
  else pipe.zrem(keys.driversGeo, String(d.id));
  await pipe.exec();
  return d;
}

export async function setDriverStatus(driverId, status, loc) {
  if (status === 'ONLINE' && !loc) {
    const { rows: [d] } = await query('SELECT lat, lng FROM drivers WHERE id=$1', [driverId]);
    if (!d || d.lat == null) throw badRequest('Location required to go online');
  }
  if (status === 'OFFLINE') {
    // Don't let a driver with orders in hand vanish from tracking.
    const { rows: [d] } = await query('SELECT active_orders FROM drivers WHERE id=$1', [driverId]);
    if (d?.active_orders > 0) throw badRequest('Finish active orders before going offline');
  }
  const { rowCount } = await query(
    `UPDATE drivers SET status=$2, lat=COALESCE($3, lat), lng=COALESCE($4, lng), last_seen_at=now() WHERE id=$1`,
    [driverId, status, loc?.lat ?? null, loc?.lng ?? null],
  );
  if (!rowCount) throw notFound('Driver not found');
  const d = await syncDriverMirror(driverId);
  emitTo(rooms.ops, 'driver:status', { id: driverId, status, lat: d.lat, lng: d.lng, active: d.active_orders });
  return d;
}

/**
 * Hot path: called on every GPS ping (every few seconds per driver).
 * Only touches Redis; positions are flushed to Postgres in batches by flushLocations().
 */
export async function updateLocation(driverId, lat, lng) {
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw badRequest('Invalid coordinates');
  const [[, status], [, orderIds]] = await redis
    .multi()
    .hget(keys.driver(driverId), 'status')
    .smembers(keys.driverOrders(driverId))
    .hset(keys.locFlush, String(driverId), `${lat},${lng}`)
    .exec();
  if (status === 'ONLINE') await redis.geoadd(keys.driversGeo, lng, lat, String(driverId));

  const payload = { driverId, lat, lng, ts: Date.now() };
  emitTo([rooms.ops, ...orderIds.map((id) => rooms.order(id))], 'driver:location', payload);
  return payload;
}

/** Batch-persist buffered positions: one UPDATE for N drivers instead of N UPDATEs per ping. */
export async function flushLocations() {
  // Atomically take the buffer so pings arriving mid-flush go into the next batch.
  const tmp = `${keys.locFlush}:${process.pid}:${Date.now()}`;
  try {
    await redis.rename(keys.locFlush, tmp);
  } catch {
    return 0; // nothing buffered
  }
  const all = await redis.hgetall(tmp);
  await redis.del(tmp);
  const entries = Object.entries(all);
  if (!entries.length) return 0;
  const ids = [], lats = [], lngs = [];
  for (const [id, v] of entries) {
    const [lat, lng] = v.split(',').map(Number);
    ids.push(Number(id)); lats.push(lat); lngs.push(lng);
  }
  await query(
    `UPDATE drivers d SET lat=v.lat, lng=v.lng, last_seen_at=now()
       FROM unnest($1::bigint[], $2::float8[], $3::float8[]) AS v(id, lat, lng)
      WHERE d.id = v.id`,
    [ids, lats, lngs],
  );
  return entries.length;
}

let flushTimer = null;
export function startLocationFlusher() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushLocations().catch((err) => logger.error({ err }, 'location flush failed'));
  }, config.driver.locationDbFlushMs);
  flushTimer.unref();
}
export function stopLocationFlusher() {
  clearInterval(flushTimer);
  flushTimer = null;
}

export async function getDriver(driverId) {
  const { rows: [d] } = await query('SELECT * FROM drivers WHERE id=$1', [driverId]);
  if (!d) throw notFound('Driver not found');
  const live = await redis.geopos(keys.driversGeo, String(driverId));
  if (live?.[0]) {
    d.lng = Number(live[0][0]);
    d.lat = Number(live[0][1]);
  }
  return d;
}

/** Rebuild the Redis mirror from Postgres (on boot, or after a Redis flush). */
export async function rebuildDriverIndex() {
  const { rows } = await query(
    'SELECT id, status, lat, lng, active_orders, max_orders, vehicle, last_assigned_at FROM drivers',
  );
  const pipe = redis.multi();
  pipe.del(keys.driversGeo);
  for (const d of rows) {
    pipe.hset(keys.driver(d.id), {
      status: d.status,
      active: d.active_orders,
      max: d.max_orders,
      vehicle: d.vehicle,
      lastAssignedAt: d.last_assigned_at ? new Date(d.last_assigned_at).getTime() : 0,
    });
    if (d.status === 'ONLINE' && d.lat != null) pipe.geoadd(keys.driversGeo, d.lng, d.lat, String(d.id));
  }
  await pipe.exec();
  const { rows: rs } = await query('SELECT id, lat, lng FROM restaurants');
  await redis.del(keys.restaurantsGeo);
  if (rs.length) {
    const args = rs.flatMap((r) => [r.lng, r.lat, String(r.id)]);
    await redis.geoadd(keys.restaurantsGeo, ...args);
  }
  return { drivers: rows.length, restaurants: rs.length };
}
