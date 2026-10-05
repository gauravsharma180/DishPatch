import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const isTest = process.env.NODE_ENV === 'test';

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  // Tests reset the schema and flush Redis, so they must never inherit the dev DATABASE_URL/REDIS_URL
  // from .env. They use TEST_* overrides or the dedicated test database / Redis db 1.
  databaseUrl: isTest
    ? process.env.TEST_DATABASE_URL || 'postgres://dishpatch:dishpatch@localhost:5432/dishpatch_test'
    : process.env.DATABASE_URL || 'postgres://dishpatch:dishpatch@localhost:5432/dishpatch',
  redisUrl: isTest
    ? process.env.TEST_REDIS_URL || 'redis://localhost:6379/1'
    : process.env.REDIS_URL || 'redis://localhost:6379/0',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  pgPoolMax: num(process.env.PG_POOL_MAX, 20),
  logLevel: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),

  // Run the dispatch worker inside the API process (handy for local dev).
  // In production you'd run `npm run worker` as a separate process instead.
  embeddedWorker: (process.env.EMBEDDED_WORKER ?? 'true') === 'true',

  cache: {
    menuTtlSec: num(process.env.MENU_CACHE_TTL, 60),
    nearbyTtlSec: num(process.env.NEARBY_CACHE_TTL, 30),
  },

  idempotency: {
    ttlSec: num(process.env.IDEMPOTENCY_TTL, 24 * 3600),
    lockTtlSec: 30,
  },

  dispatch: {
    // Search rings in km: try close drivers first, widen if nobody qualifies.
    radiiKm: (process.env.DISPATCH_RADII_KM || '3,6,10').split(',').map(Number),
    candidateLimit: num(process.env.DISPATCH_CANDIDATES, 25),
    maxAttempts: num(process.env.DISPATCH_MAX_ATTEMPTS, 8),
    retryBaseMs: num(process.env.DISPATCH_RETRY_MS, 2000),
    pollMs: num(process.env.DISPATCH_POLL_MS, 100),
    batchSize: num(process.env.DISPATCH_BATCH, 50),
    weights: {
      distance: num(process.env.W_DISTANCE, 0.4),
      eta: num(process.env.W_ETA, 0.35),
      workload: num(process.env.W_WORKLOAD, 0.25),
    },
  },

  driver: {
    locationDbFlushMs: num(process.env.DRIVER_DB_FLUSH_MS, 10000),
    staleAfterSec: num(process.env.DRIVER_STALE_SEC, 120),
  },
};
