/**
 * FoodFlow load test: drives N orders through the FULL lifecycle against a running API.
 *
 *   npm run seed            # 100 restaurants, 1000 drivers, 2000 customers
 *   npm test                # 10,000 orders, 200 concurrent flows
 *   node loadtest.js --orders 2000 --concurrency 100 --dup-rate 0.03 --hot-rate 0.05 --hot-stock 300
 *
 * Each virtual flow:  place order (Idempotency-Key)  ->  [sometimes resend the same request]
 *   -> restaurant ACCEPTED -> PREPARING -> READY -> wait for dispatch -> driver PICKED_UP -> DELIVERED
 *
 * Two deliberate stressors:
 *   dup-rate  fraction of orders whose POST is fired twice concurrently with the same key (client retry storm)
 *   hot-rate  fraction of orders that all target ONE menu item with only hot-stock units (flash-sale contention)
 *
 * After the run, invariants are checked directly in Postgres (no double orders, stock conserved,
 * no driver over capacity, every delivered order has a complete event trail).
 */
import crypto from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { Agent, setGlobalDispatcher } from 'undici';
import { io } from 'socket.io-client';
import { pool, query } from '../backend/src/db/pool.js';

const argv = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? Number(process.argv[i + 1]) : d;
};
const API = process.env.API_URL || 'http://localhost:4000';
const ORDERS = argv('orders', 10000);
const CONCURRENCY = argv('concurrency', 200);
const DUP_RATE = argv('dup-rate', 0.03);
const HOT_RATE = argv('hot-rate', 0.05);
const HOT_STOCK = argv('hot-stock', 300);
const CUSTOMERS = argv('customers', 300);
const ASSIGN_TIMEOUT_MS = 60000;

setGlobalDispatcher(new Agent({ connections: CONCURRENCY + 50, pipelining: 1, keepAliveTimeout: 30000 }));

// ------------------------------------------------------------------ http + stats
const lat = {}; // name -> number[] (ms)
const codes = {}; // name -> {status: count}
const record = (name, ms, status) => {
  (lat[name] ||= []).push(ms);
  (codes[name] ||= {})[status] = ((codes[name] ||= {})[status] || 0) + 1;
};

async function call(name, path, { token, method = 'GET', body, headers = {} } = {}) {
  const t0 = performance.now();
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  record(name, performance.now() - t0, res.status);
  return { status: res.status, body: json, headers: res.headers };
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};
const summary = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99), max: pct(arr, 100) });

// ------------------------------------------------------------------ auth (cached logins)
const tokenCache = new Map();
function token(email) {
  if (!tokenCache.has(email)) {
    tokenCache.set(
      email,
      call('login', '/api/auth/login', { method: 'POST', body: { email, password: 'password123' } }).then((r) => {
        if (r.status !== 200) throw new Error(`login ${email} -> ${r.status}`);
        return r.body.token;
      }),
    );
  }
  return tokenCache.get(email);
}

// ------------------------------------------------------------------ setup
const { rows: restaurants } = await query('SELECT id, lat, lng FROM restaurants ORDER BY id');
const { rows: menu } = await query('SELECT id, restaurant_id FROM menu_items WHERE is_available ORDER BY id');
const itemsByRest = new Map();
for (const m of menu) (itemsByRest.get(m.restaurant_id) || itemsByRest.set(m.restaurant_id, []).get(m.restaurant_id)).push(m.id);

const hotItem = menu[0];
await query('UPDATE menu_items SET stock=$2 WHERE id=$1', [hotItem.id, HOT_STOCK]);
await query(`UPDATE drivers SET status='ONLINE', active_orders=0`);
const { rows: stockBefore } = await query('SELECT id, stock FROM menu_items');
const ordersBefore = (await query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
const startTs = new Date();

// Log everyone in BEFORE the timed run: bcrypt is deliberately CPU-heavy and would otherwise
// pollute the latency numbers for the endpoints we actually care about.
const { rows: driverRows } = await query('SELECT id FROM drivers ORDER BY id');
console.log(`warming ${CUSTOMERS} customer, ${restaurants.length} owner, ${driverRows.length} driver sessions...`);
const warm = [
  ...Array.from({ length: CUSTOMERS }, (_, i) => `customer${i + 1}@foodflow.dev`),
  ...restaurants.map((r) => `owner${r.id}@foodflow.dev`),
  ...driverRows.map((d) => `driver${d.id}@foodflow.dev`),
];
for (let i = 0; i < warm.length; i += 50) await Promise.all(warm.slice(i, i + 50).map(token));
delete lat.login;
delete codes.login;

// One websocket per customer, like one phone per customer.
const sockets = new Map();
const waiters = new Map(); // orderId -> resolve(order) once a driver is assigned
const socketStats = { connected: 0, eventsReceived: 0, assignmentsViaPush: 0, fallbackPolls: 0 };
function customerSocket(email) {
  if (!sockets.has(email)) {
    sockets.set(
      email,
      token(email).then(
        (tok) =>
          new Promise((resolve, reject) => {
            const s = io(API, { auth: { token: tok }, transports: ['websocket'] });
            s.once('connect', () => {
              socketStats.connected++;
              resolve(s);
            });
            s.once('connect_error', reject);
            s.on('order:updated', (o) => {
              socketStats.eventsReceived++;
              if (o.driver_id) waiters.get(o.id)?.(o);
            });
          }),
      ),
    );
  }
  return sockets.get(email);
}
console.log(`opening ${CUSTOMERS} customer websockets...`);
await Promise.all(Array.from({ length: CUSTOMERS }, (_, i) => customerSocket(`customer${i + 1}@foodflow.dev`)));

// ------------------------------------------------------------------ one order flow
const outcome = { delivered: 0, outOfStock: 0, failed: 0, dupReplayed: 0, dupMismatch: 0, hotOk: 0, hotSoldOut: 0, assignTimeout: 0 };
const dispatchWait = [];
const flowTimes = [];
const placedIds = new Set();
const errors = [];

const rand = (a) => a[Math.floor(Math.random() * a.length)];

async function flow(i) {
  const t0 = performance.now();
  const custEmail = `customer${(i % CUSTOMERS) + 1}@foodflow.dev`;
  const cust = await token(custEmail);
  const hot = Math.random() < HOT_RATE;
  const r = hot ? restaurants.find((x) => x.id === hotItem.restaurant_id) : rand(restaurants);
  const itemIds = hot ? [hotItem.id] : [...new Set(Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => rand(itemsByRest.get(r.id))))];
  const body = {
    restaurantId: r.id,
    items: itemIds.map((id) => ({ menuItemId: id, qty: 1 })),
    deliveryLat: r.lat + (Math.random() - 0.5) * 0.04,
    deliveryLng: r.lng + (Math.random() - 0.5) * 0.04,
    address: `Load test #${i}`,
  };
  const key = crypto.randomUUID();
  const opts = { token: cust, method: 'POST', body, headers: { 'Idempotency-Key': key } };

  let placed;
  if (Math.random() < DUP_RATE) {
    // Fire the same request twice at once (double-tap / client retry), then once more after.
    const [a, b] = await Promise.all([call('place_order', '/api/orders', opts), call('place_order', '/api/orders', opts)]);
    const retry = await call('place_order_retry', '/api/orders', opts);
    placed = [a, b].find((x) => x.status === 201) || a;
    if (retry.headers.get('idempotent-replayed') === 'true') outcome.dupReplayed++;
    if (placed.status === 201 && retry.body?.id && retry.body.id !== placed.body.id) outcome.dupMismatch++;
  } else {
    placed = await call('place_order', '/api/orders', opts);
  }

  if (placed.status === 409 && placed.body?.error?.code === 'OUT_OF_STOCK') {
    outcome.outOfStock++;
    if (hot) outcome.hotSoldOut++;
    return;
  }
  if (placed.status !== 201) throw new Error(`place -> ${placed.status} ${JSON.stringify(placed.body)}`);
  if (hot) outcome.hotOk++;
  const id = placed.body.id;
  placedIds.add(id);

  const owner = await token(`owner${r.id}@foodflow.dev`);
  const move = async (tok, to, name) => {
    const res = await call(name, `/api/orders/${id}/transition`, { token: tok, method: 'POST', body: { to } });
    if (res.status !== 200) throw new Error(`${to} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };

  // Customer's tracking screen subscribes to the order room before the kitchen accepts.
  const sock = await customerSocket(custEmail);
  const assigned = new Promise((resolve) => waiters.set(id, resolve));
  const tSub = performance.now();
  const ack = await sock.timeout(5000).emitWithAck('order:subscribe', { orderId: id });
  record('socket_subscribe', performance.now() - tSub, ack?.ok ? 'ok' : 'denied');

  await move(owner, 'ACCEPTED', 'accept');
  const tAccept = performance.now();
  await move(owner, 'PREPARING', 'transition');
  await move(owner, 'READY', 'transition');

  // Wait for the dispatcher's push over Socket.IO (what the live tracking screen does).
  let order = await Promise.race([assigned, new Promise((res) => setTimeout(res, 5000, null))]);
  if (order) socketStats.assignmentsViaPush++;
  while (!order?.driver_id) {
    // Fallback poll, only if a push was missed.
    socketStats.fallbackPolls++;
    order = (await call('get_order', `/api/orders/${id}`, { token: cust })).body;
    if (order?.driver_id) break;
    if (performance.now() - tAccept > ASSIGN_TIMEOUT_MS) {
      outcome.assignTimeout++;
      throw new Error(`no driver for ${id}`);
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  waiters.delete(id);
  dispatchWait.push(performance.now() - tAccept);

  const drv = await token(`driver${order.driver_id}@foodflow.dev`);
  await move(drv, 'PICKED_UP', 'transition');
  await move(drv, 'DELIVERED', 'transition');
  await call('driver_location', '/api/drivers/me/location', {
    token: drv, method: 'POST', body: { lat: body.deliveryLat, lng: body.deliveryLng },
  });
  outcome.delivered++;
  flowTimes.push(performance.now() - t0);
}

// ------------------------------------------------------------------ run
console.log(`running ${ORDERS} orders, ${CONCURRENCY} concurrent flows...`);
let next = 0;
let done = 0;
const t0 = performance.now();
const progress = setInterval(() => {
  const s = (performance.now() - t0) / 1000;
  process.stdout.write(`\r  ${done}/${ORDERS} flows  ${(done / s).toFixed(0)} flows/s  delivered=${outcome.delivered}   `);
}, 1000);

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < ORDERS) {
      const i = next++;
      try {
        await flow(i);
      } catch (err) {
        outcome.failed++;
        if (errors.length < 20) errors.push(err.message);
      }
      done++;
    }
  }),
);
clearInterval(progress);
const wallSec = (performance.now() - t0) / 1000;
console.log('\n');

// ------------------------------------------------------------------ invariants (straight from Postgres)
const inv = {};
const newOrders = (await query('SELECT count(*)::int AS n FROM orders')).rows[0].n - ordersBefore;
inv.orders_in_db_equals_unique_201s = { pass: newOrders === placedIds.size, db: newOrders, client: placedIds.size };

const { rows: stockAfter } = await query('SELECT id, stock FROM menu_items');
const { rows: sold } = await query(
  `SELECT oi.menu_item_id AS id, sum(oi.qty)::int AS q FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.created_at >= $1 AND o.status NOT IN ('CANCELLED','REJECTED') GROUP BY 1`,
  [startTs],
);
const soldMap = new Map(sold.map((s) => [s.id, s.q]));
const beforeMap = new Map(stockBefore.map((s) => [s.id, s.stock]));
const leaks = stockAfter.filter((s) => beforeMap.get(s.id) - s.stock !== (soldMap.get(s.id) || 0));
inv.stock_conserved = { pass: leaks.length === 0, mismatched_items: leaks.length };
inv.hot_item_never_oversold = {
  pass: outcome.hotOk <= HOT_STOCK && stockAfter.find((s) => s.id === hotItem.id).stock === HOT_STOCK - (soldMap.get(hotItem.id) || 0),
  hot_stock: HOT_STOCK, hot_orders_accepted: outcome.hotOk, hot_rejected_out_of_stock: outcome.hotSoldOut,
};
const { rows: [cap] } = await query(
  'SELECT count(*) FILTER (WHERE active_orders > max_orders)::int AS over, sum(active_orders)::int AS still_active FROM drivers',
);
inv.no_driver_over_capacity = { pass: cap.over === 0, over: cap.over };
inv.all_driver_slots_released = { pass: cap.still_active === 0, still_active: cap.still_active };
const { rows: [ev] } = await query(
  `SELECT count(*)::int AS bad FROM (
     SELECT o.id FROM orders o JOIN order_events e ON e.order_id=o.id
      WHERE o.status='DELIVERED' AND o.created_at >= $1 GROUP BY o.id HAVING count(*) <> 6) t`,
  [startTs],
);
inv.complete_event_trail = { pass: ev.bad === 0, incomplete: ev.bad };
inv.idempotent_retries_returned_same_order = { pass: outcome.dupMismatch === 0, mismatches: outcome.dupMismatch, replays: outcome.dupReplayed };

// Server-side dispatch latency: ACCEPTED event -> assigned_at
const { rows: [srv] } = await query(
  `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
          percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99
     FROM (SELECT extract(epoch FROM (o.assigned_at - e.created_at))*1000 AS ms
             FROM orders o JOIN order_events e ON e.order_id=o.id AND e.to_status='ACCEPTED'
            WHERE o.created_at >= $1 AND o.assigned_at IS NOT NULL) t`,
  [startTs],
);
const { rows: [dl] } = await query(
  `SELECT round(avg(distance_m))::int AS avg_pickup_m, round(avg(eta_sec))::int AS avg_pickup_eta_s,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS decision_p95_ms,
          count(*) FILTER (WHERE outcome='ASSIGNED')::int AS assigned,
          count(*) FILTER (WHERE outcome<>'ASSIGNED')::int AS retries
     FROM dispatch_log WHERE created_at >= $1`,
  [startTs],
);

const totalRequests = Object.values(lat).reduce((a, b) => a + b.length, 0);
const report = {
  config: { orders: ORDERS, concurrency: CONCURRENCY, dupRate: DUP_RATE, hotRate: HOT_RATE, hotStock: HOT_STOCK, customers: CUSTOMERS, restaurants: restaurants.length },
  wall_seconds: Math.round(wallSec * 10) / 10,
  total_http_requests: totalRequests,
  http_rps: Math.round(totalRequests / wallSec),
  orders_placed_per_sec: Math.round(placedIds.size / wallSec),
  outcome,
  latency_ms: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, summary(v)])),
  status_codes: codes,
  dispatch: {
    client_observed_accept_to_assigned_ms: summary(dispatchWait),
    server_accept_to_assigned_ms: { p50: Math.round(srv.p50), p95: Math.round(srv.p95), p99: Math.round(srv.p99) },
    decision_p95_ms: Math.round(dl.decision_p95_ms),
    avg_pickup_distance_m: dl.avg_pickup_m,
    avg_pickup_eta_s: dl.avg_pickup_eta_s,
    assigned: dl.assigned,
    retries: dl.retries,
  },
  full_flow_ms: summary(flowTimes),
  realtime: { ...socketStats, open_websockets: sockets.size },
  invariants: inv,
  all_invariants_pass: Object.values(inv).every((x) => x.pass),
  sample_errors: errors,
  machine: { node: process.version, cpus: (await import('node:os')).cpus().length },
  ran_at: new Date().toISOString(),
};

await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(new URL('./results/latest.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
for (const sp of sockets.values()) (await sp).close();
await pool.end();
