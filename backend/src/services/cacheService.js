import { redis, keys } from '../lib/redis.js';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { cacheEvents } from '../lib/metrics.js';
import { gridCell } from '../lib/geo.js';

/**
 * Cache-aside with single-flight: concurrent misses for the same key share one DB
 * load instead of stampeding Postgres when a hot key expires.
 */
const inflight = new Map();

async function cached(cacheName, key, ttlSec, loader) {
  const hit = await redis.get(key);
  if (hit) {
    cacheEvents.inc({ cache: cacheName, result: 'hit' });
    return JSON.parse(hit);
  }
  cacheEvents.inc({ cache: cacheName, result: 'miss' });
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await loader();
      // Jitter the TTL so keys created together don't all expire together.
      const ttl = ttlSec + Math.floor(Math.random() * Math.max(1, ttlSec * 0.1));
      await redis.set(key, JSON.stringify(value), 'EX', ttl);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Menu catalogue (names, prices, availability). Stock counts are deliberately
 * shown only as an in/out flag: the authoritative stock check happens inside the
 * order transaction, so a slightly stale cache can never cause an oversell.
 */
export function getMenu(restaurantId) {
  return cached('menu', keys.menu(restaurantId), config.cache.menuTtlSec, async () => {
    const { rows: [restaurant] } = await query(
      'SELECT id, name, cuisine, lat, lng, is_open, avg_prep_minutes FROM restaurants WHERE id = $1',
      [restaurantId],
    );
    if (!restaurant) return null;
    const { rows: items } = await query(
      `SELECT id, name, price_paise, (is_available AND stock > 0) AS in_stock
         FROM menu_items WHERE restaurant_id = $1 ORDER BY id`,
      [restaurantId],
    );
    return { ...restaurant, items };
  });
}

export const invalidateMenu = (restaurantId) => redis.del(keys.menu(restaurantId));

/** Restaurants within radius, via Redis GEOSEARCH, cached per ~1km grid cell. */
export function getNearbyRestaurants(lat, lng, radiusKm = 7) {
  const cell = gridCell(lat, lng);
  return cached('nearby', keys.nearby(`${cell}:${radiusKm}`), config.cache.nearbyTtlSec, async () => {
    const hits = await redis.geosearch(
      keys.restaurantsGeo, 'FROMLONLAT', lng, lat, 'BYRADIUS', radiusKm, 'km', 'ASC', 'COUNT', 50, 'WITHDIST',
    );
    if (!hits.length) return [];
    const ids = hits.map(([id]) => Number(id));
    const dist = new Map(hits.map(([id, d]) => [Number(id), Number(d)]));
    const { rows } = await query(
      'SELECT id, name, cuisine, lat, lng, is_open, avg_prep_minutes FROM restaurants WHERE id = ANY($1)',
      [ids],
    );
    return rows
      .map((r) => ({ ...r, distance_km: Math.round(dist.get(r.id) * 100) / 100 }))
      .sort((a, b) => a.distance_km - b.distance_km);
  });
}
