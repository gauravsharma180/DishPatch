// Standalone dispatch worker: `npm run worker`. Run several for horizontal scale;
// set EMBEDDED_WORKER=false on the API nodes when you do.
import { startDispatchWorker } from './dispatcher.js';
import { logger } from '../lib/logger.js';
import { pool } from '../db/pool.js';
import { redis } from '../lib/redis.js';

const stop = startDispatchWorker();

async function shutdown() {
  logger.info('worker shutting down');
  stop();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
