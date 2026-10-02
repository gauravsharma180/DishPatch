import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createRedis } from '../lib/redis.js';
import { verifyToken } from '../middleware/auth.js';
import { query } from '../db/pool.js';
import { updateLocation } from '../services/driverService.js';
import { attachIo, rooms } from './emitter.js';
import { logger } from '../lib/logger.js';

const MIN_PING_INTERVAL_MS = 1000; // server-side throttle on GPS pings per driver

export function initSockets(httpServer) {
  const io = new Server(httpServer, { cors: { origin: '*' } });

  // Redis adapter: an event emitted on API node A reaches sockets connected to node B.
  const pub = createRedis();
  const sub = createRedis();
  io.adapter(createAdapter(pub, sub));

  io.use((socket, next) => {
    try {
      const p = verifyToken(socket.handshake.auth?.token);
      socket.data.user = { id: p.sub, role: p.role, restaurantId: p.restaurantId, driverId: p.driverId };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    if (u.role === 'RESTAURANT' && u.restaurantId) socket.join(rooms.restaurant(u.restaurantId));
    if (u.role === 'DRIVER' && u.driverId) socket.join(rooms.driver(u.driverId));
    if (u.role === 'ADMIN') socket.join(rooms.ops);

    // Clients ask to follow a specific order; we check they're allowed to see it.
    socket.on('order:subscribe', async ({ orderId } = {}, ack) => {
      try {
        const { rows: [o] } = await query('SELECT customer_id, restaurant_id, driver_id FROM orders WHERE id=$1', [orderId]);
        const ok =
          o &&
          (u.role === 'ADMIN' ||
            (u.role === 'CUSTOMER' && o.customer_id === u.id) ||
            (u.role === 'RESTAURANT' && o.restaurant_id === u.restaurantId) ||
            (u.role === 'DRIVER' && o.driver_id === u.driverId));
        if (ok) socket.join(rooms.order(orderId));
        ack?.({ ok: !!ok });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('order:unsubscribe', ({ orderId } = {}) => socket.leave(rooms.order(orderId)));

    let lastPing = 0;
    socket.on('driver:location', async ({ lat, lng } = {}, ack) => {
      if (u.role !== 'DRIVER') return ack?.({ ok: false, error: 'not a driver' });
      const now = Date.now();
      if (now - lastPing < MIN_PING_INTERVAL_MS) return ack?.({ ok: false, error: 'throttled' });
      lastPing = now;
      try {
        await updateLocation(u.driverId, Number(lat), Number(lng));
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });
  });

  attachIo(io);
  logger.info('socket.io ready (redis adapter)');
  return io;
}
