import { Router } from 'express';
import { query } from '../db/pool.js';
import { redis, keys } from '../lib/redis.js';
import { ah } from '../lib/errors.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { queueDepth } from '../dispatch/queue.js';

const r = Router();
r.use(authenticate, requireRole('ADMIN'));

r.get(
  '/overview',
  ah(async (_req, res) => {
    const [byStatus, byDispatch, drivers, dispatch, depth] = await Promise.all([
      query('SELECT status, count(*)::int AS n FROM orders GROUP BY status'),
      query('SELECT dispatch_state, count(*)::int AS n FROM orders GROUP BY dispatch_state'),
      query(`SELECT status, count(*)::int AS n, sum(active_orders)::int AS load FROM drivers GROUP BY status`),
      query(`
        SELECT count(*) FILTER (WHERE outcome='ASSIGNED')::int AS assigned,
               count(*) FILTER (WHERE outcome='NO_CANDIDATES')::int AS no_candidates,
               count(*) FILTER (WHERE outcome='FAILED')::int AS failed,
               round(avg(distance_m) FILTER (WHERE outcome='ASSIGNED'))::int AS avg_pickup_distance_m,
               round(avg(eta_sec) FILTER (WHERE outcome='ASSIGNED'))::int AS avg_pickup_eta_sec,
               round(avg(latency_ms) FILTER (WHERE outcome='ASSIGNED'))::int AS avg_decision_ms
          FROM dispatch_log WHERE created_at > now() - interval '24 hours'`),
      queueDepth(),
    ]);
    const toMap = (rows, k) => Object.fromEntries(rows.map((x) => [x[k], x.n]));
    res.json({
      orders: toMap(byStatus.rows, 'status'),
      dispatchStates: toMap(byDispatch.rows, 'dispatch_state'),
      drivers: Object.fromEntries(drivers.rows.map((x) => [x.status, { count: x.n, load: x.load }])),
      dispatch: dispatch.rows[0],
      queueDepth: depth,
    });
  }),
);

// Live positions straight from the Redis GEO index (what the dispatcher sees).
r.get(
  '/drivers/live',
  ah(async (_req, res) => {
    const members = await redis.zrange(keys.driversGeo, 0, -1);
    if (!members.length) return res.json([]);
    const pipe = redis.pipeline();
    pipe.geopos(keys.driversGeo, ...members);
    for (const id of members) pipe.hgetall(keys.driver(id));
    const out = await pipe.exec();
    const pos = out[0][1];
    res.json(
      members.map((id, i) => ({
        id: Number(id),
        lng: Number(pos[i]?.[0]),
        lat: Number(pos[i]?.[1]),
        active: Number(out[i + 1][1].active || 0),
        max: Number(out[i + 1][1].max || 0),
      })),
    );
  }),
);

r.get(
  '/dispatch-log',
  ah(async (req, res) => {
    const { rows } = req.query.orderId
      ? await query('SELECT * FROM dispatch_log WHERE order_id=$1 ORDER BY id', [req.query.orderId])
      : await query('SELECT * FROM dispatch_log ORDER BY id DESC LIMIT 100');
    res.json(rows);
  }),
);

export default r;
