// Integration tests against real Postgres + Redis (dishpatch_test DB, Redis db 1).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { pool, query } from '../src/db/pool.js';
import { redis } from '../src/lib/redis.js';
import { closeEmitter } from '../src/realtime/emitter.js';
import { dispatchOrder } from '../src/dispatch/dispatcher.js';
import { rebuildDriverIndex } from '../src/services/driverService.js';

const app = createApp();
const tokens = {};

async function login(email) {
  if (tokens[email]) return tokens[email];
  const res = await request(app).post('/api/auth/login').send({ email, password: 'password123' }).expect(200);
  return (tokens[email] = res.body.token);
}
const customer = (n) => login(`customer${n}@dishpatch.dev`);

async function place(n, body, key = crypto.randomUUID()) {
  return request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${await customer(n)}`)
    .set('Idempotency-Key', key)
    .send({ restaurantId: 1, deliveryLat: 12.97, deliveryLng: 77.6, items: [{ menuItemId: 1, qty: 1 }], ...body });
}

async function move(orderId, to, token) {
  return request(app).post(`/api/orders/${orderId}/transition`).set('Authorization', `Bearer ${token}`).send({ to });
}

const stockOf = async (id) => (await query('SELECT stock FROM menu_items WHERE id=$1', [id])).rows[0].stock;

/** Put specific drivers online at given offsets (metres north) from restaurant 1; everyone else offline. */
async function placeDrivers(spec) {
  const { rows: [r] } = await query('SELECT lat, lng FROM restaurants WHERE id=1');
  await query(`UPDATE drivers SET status='OFFLINE', active_orders=0, last_assigned_at=NULL`);
  for (const { id, metres, max = 2, active = 0 } of spec) {
    await query(`UPDATE drivers SET status='ONLINE', lat=$2, lng=$3, max_orders=$4, active_orders=$5 WHERE id=$1`, [
      id, r.lat + metres / 111_000, r.lng, max, active,
    ]);
  }
  await rebuildDriverIndex();
}

before(async () => {
  await seed({ restaurants: 2, drivers: 5, customers: 80, stock: 50 });
});

after(async () => {
  await closeEmitter();
  await pool.end();
  await redis.quit();
});

describe('idempotent order placement', () => {
  test('retry with the same key returns the same order and reserves stock once', async () => {
    const before = await stockOf(1);
    const key = crypto.randomUUID();
    const a = await place(1, { items: [{ menuItemId: 1, qty: 2 }] }, key);
    const b = await place(1, { items: [{ menuItemId: 1, qty: 2 }] }, key);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers['idempotent-replayed'], 'true');
    assert.equal(a.body.id, b.body.id);
    assert.equal(await stockOf(1), before - 2);
  });

  test('same key with a different payload is rejected', async () => {
    const key = crypto.randomUUID();
    await place(2, {}, key).then((r) => assert.equal(r.status, 201));
    const r = await place(2, { items: [{ menuItemId: 1, qty: 3 }] }, key);
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  test('10 concurrent duplicates create exactly one order', async () => {
    const key = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => place(3, {}, key)));
    const ids = new Set(results.filter((r) => r.status < 300).map((r) => r.body.id));
    assert.equal(ids.size, 1);
    for (const r of results) assert.ok([201, 409].includes(r.status), `unexpected ${r.status}`);
    const { rows } = await query('SELECT count(*)::int AS n FROM orders WHERE idempotency_key=$1', [key]);
    assert.equal(rows[0].n, 1);
  });

  test('DB unique constraint catches duplicates even if Redis lost the key', async () => {
    const key = crypto.randomUUID();
    const a = await place(4, {}, key);
    await redis.del((await redis.keys(`idem:*:${key}`))[0]);
    const b = await place(4, {}, key);
    assert.equal(b.status, 200);
    assert.equal(a.body.id, b.body.id);
  });

  test('missing Idempotency-Key is a 400', async () => {
    const r = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${await customer(1)}`)
      .send({ restaurantId: 1, deliveryLat: 12.97, deliveryLng: 77.6, items: [{ menuItemId: 1, qty: 1 }] });
    assert.equal(r.status, 400);
  });
});

describe('transactional inventory', () => {
  test('40 customers racing for 5 plates: exactly 5 orders succeed, stock never negative', async () => {
    await query('UPDATE menu_items SET stock=5 WHERE id=2');
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => place(10 + i, { items: [{ menuItemId: 2, qty: 1 }] })),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const sold = results.filter((r) => r.body?.error?.code === 'OUT_OF_STOCK').length;
    assert.equal(ok, 5);
    assert.equal(sold, 35);
    assert.equal(await stockOf(2), 0);
  });

  test('multi-item order is all-or-nothing', async () => {
    await query('UPDATE menu_items SET stock=10 WHERE id=3');
    await query('UPDATE menu_items SET stock=0 WHERE id=4');
    const r = await place(5, { items: [{ menuItemId: 3, qty: 2 }, { menuItemId: 4, qty: 1 }] });
    assert.equal(r.status, 409);
    assert.equal(await stockOf(3), 10, 'item 3 must be rolled back');
  });

  test('cancelling restores stock; menu cache shows item back in stock', async () => {
    await query('UPDATE menu_items SET stock=1 WHERE id=5');
    const r = await place(6, { items: [{ menuItemId: 5, qty: 1 }] });
    let menu = await request(app).get('/api/restaurants/1/menu');
    assert.equal(menu.body.items.find((i) => i.id === 5).in_stock, false);
    const c = await move(r.body.id, 'CANCELLED', await customer(6));
    assert.equal(c.body.status, 'CANCELLED');
    assert.equal(await stockOf(5), 1);
    menu = await request(app).get('/api/restaurants/1/menu');
    assert.equal(menu.body.items.find((i) => i.id === 5).in_stock, true);
  });
});

describe('order lifecycle', () => {
  test('illegal transitions and wrong actors are rejected', async () => {
    const r = await place(7);
    const owner = await login('owner1@dishpatch.dev');
    assert.equal((await move(r.body.id, 'DELIVERED', owner)).status, 409);
    assert.equal((await move(r.body.id, 'ACCEPTED', await customer(7))).status, 409);
    assert.equal((await move(r.body.id, 'ACCEPTED', await login('owner2@dishpatch.dev'))).status, 403);
    assert.equal((await move(r.body.id, 'CANCELLED', await customer(8))).status, 403);
  });

  test('repeating the current status is a safe no-op', async () => {
    const r = await place(8);
    const owner = await login('owner1@dishpatch.dev');
    const a = await move(r.body.id, 'ACCEPTED', owner);
    const b = await move(r.body.id, 'ACCEPTED', owner);
    assert.equal(b.status, 200);
    assert.equal(a.body.version, b.body.version);
  });
});

describe('dispatch engine', () => {
  async function acceptedOrder(n) {
    const r = await place(n);
    await move(r.body.id, 'ACCEPTED', await login('owner1@dishpatch.dev'));
    return r.body.id;
  }

  test('assigns the nearest available driver and records the decision', async () => {
    await placeDrivers([{ id: 1, metres: 2500 }, { id: 2, metres: 300 }, { id: 3, metres: 200, active: 2 }]);
    const id = await acceptedOrder(20);
    const res = await dispatchOrder(id);
    assert.equal(res.outcome, 'ASSIGNED');
    assert.equal(res.driverId, 2, 'driver 3 is closer but full');
    const { rows: [log] } = await query(`SELECT * FROM dispatch_log WHERE order_id=$1`, [id]);
    assert.equal(log.outcome, 'ASSIGNED');
    const { rows: [d] } = await query('SELECT active_orders FROM drivers WHERE id=2');
    assert.equal(d.active_orders, 1);
  });

  test('concurrent dispatch never over-assigns a driver beyond capacity', async () => {
    await placeDrivers([{ id: 1, metres: 100, max: 1 }]);
    const ids = await Promise.all([21, 22, 23, 24].map(acceptedOrder));
    const results = await Promise.all(ids.map((id) => dispatchOrder(id)));
    assert.equal(results.filter((r) => r.outcome === 'ASSIGNED').length, 1);
    const { rows: [d] } = await query('SELECT active_orders FROM drivers WHERE id=1');
    assert.equal(d.active_orders, 1);
  });

  test('no driver in range -> retry scheduled; driver rejection -> reassigned to someone else', async () => {
    await placeDrivers([]);
    const id = await acceptedOrder(25);
    assert.equal((await dispatchOrder(id)).outcome, 'RETRY');

    await placeDrivers([{ id: 4, metres: 100 }, { id: 5, metres: 900 }]);
    assert.equal((await dispatchOrder(id)).driverId, 4);
    const driver4 = await login('driver4@dishpatch.dev');
    const rej = await request(app).post(`/api/orders/${id}/reject-assignment`).set('Authorization', `Bearer ${driver4}`);
    assert.equal(rej.status, 200);
    assert.equal((await dispatchOrder(id)).driverId, 5);
  });

  test('full delivery releases the driver slot', async () => {
    await placeDrivers([{ id: 1, metres: 100 }]);
    const id = await acceptedOrder(26);
    await dispatchOrder(id);
    const owner = await login('owner1@dishpatch.dev');
    const driver = await login('driver1@dishpatch.dev');
    assert.equal((await move(id, 'PICKED_UP', driver)).status, 409, 'not ready yet');
    await move(id, 'PREPARING', owner);
    await move(id, 'READY', owner);
    await move(id, 'PICKED_UP', driver);
    const done = await move(id, 'DELIVERED', driver);
    assert.equal(done.body.status, 'DELIVERED');
    const { rows: [d] } = await query('SELECT active_orders FROM drivers WHERE id=1');
    assert.equal(d.active_orders, 0);
    const events = (await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${await customer(26)}`)).body.events;
    assert.deepEqual(events.map((e) => e.to_status), ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED']);
  });
});
