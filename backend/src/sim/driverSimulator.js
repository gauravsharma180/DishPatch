/**
 * City simulator: brings the system to life for demos.
 *   node src/sim/driverSimulator.js --drivers 49 --speed 8 --kitchens --customers 0.5
 *
 * --drivers N    log in N riders starting at driver{--first} (default 2, so driver1 stays yours)
 * --speed X      time multiplier (8 = riders move 8x real speed, kitchens cook 8x faster)
 * --kitchens     auto-accept / prepare / mark-ready orders like a restaurant tablet would
 * --customers R  place R random orders per second from random customers (0 = off)
 */
import { io } from 'socket.io-client';
import crypto from 'node:crypto';
import { stepToward } from '../lib/geo.js';

const API = process.env.API_URL || 'http://localhost:4000';
const argv = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : Number(v);
};
const FIRST = argv('first', 2); // driver1 is left free so you can play rider yourself
const DRIVERS = argv('drivers', 49);
const SPEED = argv('speed', 8);
const KITCHENS = !!argv('kitchens', false);
const CUSTOMER_RATE = argv('customers', 0);
const TICK_MS = 1000;
const RIDER_MPS = 6; // ~22 km/h

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || res.statusText), { status: res.status, body: json });
  return json;
}
const login = (email) => api('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });

// ---------------------------------------------------------------- drivers
class SimDriver {
  constructor(n) {
    this.n = n;
    this.queue = []; // assigned orders
    this.busy = false;
  }

  async start() {
    const { token, user } = await login(`driver${this.n}@dishpatch.dev`);
    this.token = token;
    this.id = user.driverId;
    const me = await api('/api/drivers/me', { token });
    this.lat = me.lat;
    this.lng = me.lng;
    await api('/api/drivers/me/status', { token, method: 'POST', body: { status: 'ONLINE', lat: this.lat, lng: this.lng } });
    for (const o of me.activeOrders) this.queue.push(o);

    this.socket = io(API, { auth: { token }, transports: ['websocket'] });
    this.socket.on('assignment:new', (o) => {
      console.log(`🛵 driver ${this.id} ← order ${o.id.slice(0, 8)} (${o.restaurant_name})`);
      this.queue.push(o);
    });
    this.socket.on('assignment:removed', ({ orderId }) => (this.queue = this.queue.filter((o) => o.id !== orderId)));
    this.socket.on('order:updated', (o) => {
      const q = this.queue.find((x) => x.id === o.id);
      if (q) Object.assign(q, o);
      if (o.status === 'CANCELLED') this.queue = this.queue.filter((x) => x.id !== o.id);
    });
    this.loop();
  }

  async moveTo(lat, lng) {
    for (;;) {
      const s = stepToward(this.lat, this.lng, lat, lng, RIDER_MPS * (TICK_MS / 1000) * SPEED);
      this.lat = s.lat;
      this.lng = s.lng;
      this.socket.emit('driver:location', { lat: this.lat, lng: this.lng });
      if (s.arrived) return;
      await sleep(TICK_MS);
    }
  }

  async loop() {
    for (;;) {
      const order = this.queue[0];
      if (!order) {
        await sleep(500);
        continue;
      }
      try {
        if (order.status !== 'PICKED_UP') {
          await this.moveTo(order.restaurant_lat, order.restaurant_lng);
          while (this.queue.includes(order) && order.status !== 'READY') await sleep(300); // wait at counter
          if (!this.queue.includes(order)) continue;
          Object.assign(order, await api(`/api/orders/${order.id}/transition`, { token: this.token, method: 'POST', body: { to: 'PICKED_UP' } }));
        }
        await this.moveTo(order.delivery_lat, order.delivery_lng);
        await api(`/api/orders/${order.id}/transition`, { token: this.token, method: 'POST', body: { to: 'DELIVERED' } });
        console.log(`✅ driver ${this.id} delivered ${order.id.slice(0, 8)}`);
      } catch (err) {
        console.warn(`driver ${this.id}: ${err.message}`);
      }
      this.queue = this.queue.filter((o) => o !== order);
    }
  }
}

// ---------------------------------------------------------------- kitchens
async function runKitchens() {
  const admin = await login('admin@dishpatch.dev');
  const owners = new Map(); // restaurantId -> token
  const ownerToken = async (rid) => {
    if (!owners.has(rid)) {
      // seed maps ownerN -> restaurant N
      const { token } = await login(`owner${rid}@dishpatch.dev`);
      owners.set(rid, token);
    }
    return owners.get(rid);
  };
  const move = async (o, to) => {
    const token = await ownerToken(o.restaurant_id);
    return api(`/api/orders/${o.id}/transition`, { token, method: 'POST', body: { to } });
  };
  const socket = io(API, { auth: { token: admin.token }, transports: ['websocket'] });
  socket.on('order:new', async (o) => {
    try {
      await sleep(2000 / SPEED + Math.random() * 1000);
      const accepted = await move(o, 'ACCEPTED');
      await move(o, 'PREPARING');
      const prepMs = Math.max(0, new Date(accepted.ready_by) - Date.now()) / SPEED;
      await sleep(prepMs);
      await move(o, 'READY');
      console.log(`🍳 ${o.restaurant_name} ready: ${o.id.slice(0, 8)}`);
    } catch (err) {
      console.warn(`kitchen: ${err.message}`);
    }
  });
  console.log('kitchens online');
}

// ---------------------------------------------------------------- customers
async function runCustomers(rate) {
  const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => login(`customer${i + 2}@dishpatch.dev`).then((r) => r.token)));
  for (;;) {
    const token = tokens[Math.floor(Math.random() * tokens.length)];
    const lat = 12.9716 + (Math.random() - 0.5) * 0.08;
    const lng = 77.5946 + (Math.random() - 0.5) * 0.08;
    try {
      const nearby = await api(`/api/restaurants?lat=${lat}&lng=${lng}&radiusKm=5`);
      const r = nearby[Math.floor(Math.random() * Math.min(5, nearby.length))];
      if (r) {
        const menu = await api(`/api/restaurants/${r.id}/menu`);
        const items = menu.items.filter((i) => i.in_stock).sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
        await api('/api/orders', {
          token,
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: { restaurantId: r.id, items: items.map((i) => ({ menuItemId: i.id, qty: 1 })), deliveryLat: lat, deliveryLng: lng, address: 'Simulated address' },
        });
      }
    } catch (err) {
      console.warn(`customer: ${err.message}`);
    }
    await sleep(1000 / rate);
  }
}

async function main() {
  console.log(`sim: ${DRIVERS} drivers, speed x${SPEED}, kitchens=${KITCHENS}, customers=${CUSTOMER_RATE}/s`);
  const drivers = Array.from({ length: DRIVERS }, (_, i) => new SimDriver(FIRST + i));
  for (const d of drivers) await d.start();
  console.log(`${DRIVERS} drivers online`);
  if (KITCHENS) await runKitchens();
  if (CUSTOMER_RATE > 0) runCustomers(CUSTOMER_RATE);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
