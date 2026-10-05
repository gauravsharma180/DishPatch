import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { AppError } from './lib/errors.js';
import { registry, httpDuration } from './lib/metrics.js';
import { pool } from './db/pool.js';
import { redis } from './lib/redis.js';
import authRoutes from './routes/auth.js';
import restaurantRoutes from './routes/restaurants.js';
import orderRoutes from './routes/orders.js';
import driverRoutes from './routes/drivers.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  if (['debug', 'info', 'trace'].includes(logger.level)) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' } }));
  }

  // Latency histogram per route template (not per URL, to keep label cardinality bounded).
  app.use((req, res, next) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      end({ method: req.method, route, status: res.statusCode });
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    const [db, cache] = await Promise.allSettled([pool.query('SELECT 1'), redis.ping()]);
    const ok = db.status === 'fulfilled' && cache.status === 'fulfilled';
    res.status(ok ? 200 : 503).json({ ok, db: db.status, redis: cache.status });
  });

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/restaurants', restaurantRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/drivers', driverRoutes);
  app.use('/api/admin', adminRoutes);

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    // Postgres "invalid text representation" (bad UUID / enum value in a URL or query string).
    if (err.code === '22P02') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid identifier or value' } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON' } });
    }
    (req.log || logger).error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  return app;
}
