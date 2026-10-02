/**
 * Multi-core mode: `npm run start:cluster` (WEB_CONCURRENCY=N, default = CPU count).
 *
 * The primary bootstraps once (migrations + Redis GEO rebuild), then forks N API workers
 * that share port 4000. This works because the API is stateless:
 *   - sessions are JWTs, idempotency/cache/geo state lives in Redis, truth lives in Postgres
 *   - Socket.IO's Redis adapter fans events out across workers
 *     (clients use the websocket transport, so no sticky sessions are needed)
 * Exactly one worker runs the embedded dispatch loop; it's safe to run more since
 * queue claims are atomic, but one is plenty for a single box.
 */
import cluster from 'node:cluster';
import os from 'node:os';

const N = Number(process.env.WEB_CONCURRENCY) || os.availableParallelism();

if (cluster.isPrimary) {
  const { migrate } = await import('./db/migrate.js');
  const { rebuildDriverIndex } = await import('./services/driverService.js');
  const { pool } = await import('./db/pool.js');
  const { redis } = await import('./lib/redis.js');
  await migrate();
  const idx = await rebuildDriverIndex();
  await pool.end();
  await redis.quit();
  console.log(`primary ${process.pid}: bootstrapped`, idx, `forking ${N} workers`);

  const fork = (i) => {
    const w = cluster.fork({ SKIP_BOOTSTRAP: '1', EMBEDDED_WORKER: i === 0 ? 'true' : 'false', WORKER_INDEX: String(i) });
    w.on('exit', (code, sig) => {
      if (sig === 'SIGTERM' || sig === 'SIGINT' || code === 0) return;
      console.error(`worker ${i} died (${sig || code}), restarting`);
      fork(i);
    });
  };
  for (let i = 0; i < N; i++) fork(i);

  const stop = () => {
    for (const w of Object.values(cluster.workers)) w.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  await import('./server.js');
}
