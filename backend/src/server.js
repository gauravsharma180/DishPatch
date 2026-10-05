import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { initSockets } from './realtime/socket.js';
import { logger } from './lib/logger.js';
import { pool } from './db/pool.js';
import { redis } from './lib/redis.js';
import { migrate } from './db/migrate.js';
import { rebuildDriverIndex, startLocationFlusher, stopLocationFlusher, flushLocations } from './services/driverService.js';
import { startDispatchWorker } from './dispatch/dispatcher.js';

async function main() {
  if (!process.env.SKIP_BOOTSTRAP) {
    await migrate();
    // Redis is a cache/index, Postgres is truth: rebuild the GEO indexes on boot.
    const idx = await rebuildDriverIndex();
    logger.info(idx, 'geo indexes rebuilt');
  }

  const app = createApp();
  const server = http.createServer(app);
  initSockets(server);
  startLocationFlusher();
  const stopWorker = config.embeddedWorker ? startDispatchWorker() : () => {};

  server.listen(config.port, () => logger.info(`DishPatch API on :${config.port}`));

  const shutdown = async (sig) => {
    logger.info({ sig }, 'shutting down');
    stopWorker();
    stopLocationFlusher();
    server.close();
    await flushLocations().catch(() => {});
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
