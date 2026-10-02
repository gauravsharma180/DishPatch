/**
 * Seed a city's worth of data around central Bengaluru.
 *   node src/db/seed.js [--restaurants 40] [--drivers 50] [--customers 500] [--stock 500]
 * All accounts use the password "password123".
 * Demo logins: customer1@foodflow.dev, owner1@foodflow.dev, driver1@foodflow.dev, admin@foodflow.dev
 */
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { migrate } from './migrate.js';
import { redis } from '../lib/redis.js';
import { rebuildDriverIndex } from '../services/driverService.js';

const CENTER = { lat: 12.9716, lng: 77.5946 };
export const PASSWORD = 'password123';

const CUISINES = {
  'North Indian': ['Paneer Butter Masala', 'Dal Makhani', 'Butter Naan', 'Chole Bhature', 'Jeera Rice', 'Rajma Chawal', 'Lassi', 'Gulab Jamun'],
  'South Indian': ['Masala Dosa', 'Idli Vada', 'Rava Dosa', 'Pongal', 'Bisi Bele Bath', 'Filter Coffee', 'Uttapam', 'Kesari Bath'],
  Biryani: ['Chicken Dum Biryani', 'Mutton Biryani', 'Veg Biryani', 'Egg Biryani', 'Chicken 65', 'Raita', 'Mirchi Ka Salan', 'Double Ka Meetha'],
  Chinese: ['Veg Hakka Noodles', 'Chilli Paneer', 'Fried Rice', 'Manchurian', 'Spring Rolls', 'Hot & Sour Soup', 'Chilli Chicken', 'Momos'],
  Pizza: ['Margherita', 'Farmhouse', 'Pepperoni', 'Paneer Tikka Pizza', 'Garlic Bread', 'Pasta Alfredo', 'Choco Lava Cake', 'Cold Coffee'],
};
const NAMES = ['Spice', 'Tandoor', 'Dosa', 'Wok', 'Slice', 'Masala', 'Royal', 'Urban', 'Corner', 'Green', 'Golden', 'Namma'];
const SUFFIX = ['House', 'Kitchen', 'Express', 'Point', 'Junction', 'Cafe', 'Bistro', 'Hub'];

// Deterministic PRNG so every seed produces the same city.
function rng(seed = 42) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
const rand = rng();
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const jitter = (km) => {
  // uniform point in a disc of radius km
  const r = km * Math.sqrt(rand());
  const t = rand() * 2 * Math.PI;
  return { lat: CENTER.lat + (r / 111) * Math.cos(t), lng: CENTER.lng + (r / (111 * Math.cos((CENTER.lat * Math.PI) / 180))) * Math.sin(t) };
};

function arg(name, d) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : d;
}

export async function seed({ restaurants = 40, drivers = 300, customers = 500, stock = 500 } = {}) {
  await migrate({ reset: true });
  await redis.flushdb();
  const hash = await bcrypt.hash(PASSWORD, 8);

  // Users (bulk insert via unnest: one round trip instead of thousands)
  const users = [{ name: 'Ops Admin', email: 'admin@foodflow.dev', role: 'ADMIN' }];
  for (let i = 1; i <= customers; i++) users.push({ name: `Customer ${i}`, email: `customer${i}@foodflow.dev`, role: 'CUSTOMER' });
  for (let i = 1; i <= restaurants; i++) users.push({ name: `Owner ${i}`, email: `owner${i}@foodflow.dev`, role: 'RESTAURANT' });
  for (let i = 1; i <= drivers; i++) users.push({ name: `Driver ${i}`, email: `driver${i}@foodflow.dev`, role: 'DRIVER' });
  const { rows: inserted } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     SELECT n, e, $3, r::user_role FROM unnest($1::text[], $2::text[], $4::text[]) AS t(n, e, r)
     RETURNING id, email`,
    [users.map((u) => u.name), users.map((u) => u.email), hash, users.map((u) => u.role)],
  );
  const idByEmail = new Map(inserted.map((u) => [u.email, u.id]));

  // Restaurants within 6km of the centre
  const rest = [];
  for (let i = 1; i <= restaurants; i++) {
    const cuisine = pick(Object.keys(CUISINES));
    const p = jitter(6);
    rest.push({ owner: idByEmail.get(`owner${i}@foodflow.dev`), name: `${pick(NAMES)} ${pick(SUFFIX)} #${i}`, cuisine, ...p, prep: 10 + Math.floor(rand() * 15) });
  }
  const { rows: restRows } = await pool.query(
    `INSERT INTO restaurants (owner_id, name, cuisine, lat, lng, avg_prep_minutes)
     SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::float8[], $5::float8[], $6::int[])
     RETURNING id, cuisine`,
    [rest.map((r) => r.owner), rest.map((r) => r.name), rest.map((r) => r.cuisine), rest.map((r) => r.lat), rest.map((r) => r.lng), rest.map((r) => r.prep)],
  );

  // Menus
  const mi = { rid: [], name: [], price: [], stock: [] };
  for (const r of restRows) {
    for (const dish of CUISINES[r.cuisine]) {
      mi.rid.push(r.id); mi.name.push(dish);
      mi.price.push((80 + Math.floor(rand() * 32) * 10) * 100); // ₹80–₹390 in paise
      mi.stock.push(stock);
    }
  }
  await pool.query(
    `INSERT INTO menu_items (restaurant_id, name, price_paise, stock)
     SELECT * FROM unnest($1::bigint[], $2::text[], $3::int[], $4::int[])`,
    [mi.rid, mi.name, mi.price, mi.stock],
  );

  // Drivers: scattered within 8km, mixed vehicles, capacity 2
  const dv = { uid: [], name: [], vehicle: [], lat: [], lng: [] };
  for (let i = 1; i <= drivers; i++) {
    const p = jitter(8);
    dv.uid.push(idByEmail.get(`driver${i}@foodflow.dev`)); dv.name.push(`Driver ${i}`);
    dv.vehicle.push(rand() < 0.8 ? 'BIKE' : 'SCOOTER'); dv.lat.push(p.lat); dv.lng.push(p.lng);
  }
  await pool.query(
    // driver1 starts OFFLINE: it's the account you play yourself (the simulator drives 2..N).
    `INSERT INTO drivers (user_id, name, vehicle, status, lat, lng, last_seen_at)
     SELECT u, n, v, CASE WHEN ord = 1 THEN 'OFFLINE' ELSE 'ONLINE' END::driver_status, la, ln, now()
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::float8[], $5::float8[]) WITH ORDINALITY AS t(u, n, v, la, ln, ord)`,
    [dv.uid, dv.name, dv.vehicle, dv.lat, dv.lng],
  );

  const idx = await rebuildDriverIndex();
  return { users: inserted.length, restaurants: restRows.length, menuItems: mi.rid.length, ...idx };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed({
    restaurants: arg('restaurants', 40),
    drivers: arg('drivers', 50),
    customers: arg('customers', 500),
    stock: arg('stock', 500),
  })
    .then((s) => console.log('seeded', s))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
      await redis.quit();
    });
}
