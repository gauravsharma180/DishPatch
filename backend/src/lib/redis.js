import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

// Separate connections for Socket.IO pub/sub (a subscribed connection can't run normal commands).
export const createRedis = () => new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

export const keys = {
  driversGeo: 'geo:drivers',            // GEO set of ONLINE drivers
  restaurantsGeo: 'geo:restaurants',    // GEO set of restaurants
  driver: (id) => `driver:${id}`,       // HASH: status, active, max, vehicle, lastAssignedAt
  driverOrders: (id) => `driver:${id}:orders`, // SET of active order ids (for location fan-out)
  menu: (rid) => `cache:menu:${rid}`,
  nearby: (cell) => `cache:nearby:${cell}`,
  idem: (scope, key) => `idem:${scope}:${key}`,
  dispatchQueue: 'dispatch:queue',      // ZSET orderId -> due timestamp (ms)
  dispatchExclude: (orderId) => `dispatch:exclude:${orderId}`, // SET of drivers who rejected
  locFlush: 'driver:locflush',          // HASH driverId -> "lat,lng" pending DB flush
};
