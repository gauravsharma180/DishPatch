import { Emitter } from '@socket.io/redis-emitter';
import { createRedis } from '../lib/redis.js';

/**
 * One place for "push an event to clients".
 * - Inside the API process we emit through the live Socket.IO server.
 * - In a standalone dispatch worker (no sockets) we publish through Redis; the
 *   Socket.IO redis-adapter on every API node picks it up and forwards to clients.
 */
let io = null;
let redisEmitter = null;
let emitterClient = null;

export async function closeEmitter() {
  if (emitterClient) await emitterClient.quit();
  emitterClient = null;
  redisEmitter = null;
}

export const attachIo = (server) => {
  io = server;
};

function target() {
  if (io) return io;
  if (!redisEmitter) {
    emitterClient = createRedis();
    redisEmitter = new Emitter(emitterClient);
  }
  return redisEmitter;
}

export const rooms = {
  order: (id) => `order:${id}`,
  restaurant: (id) => `restaurant:${id}`,
  driver: (id) => `driver:${id}`,
  ops: 'ops',
};

export function emitTo(roomList, event, payload) {
  const t = target();
  const list = Array.isArray(roomList) ? roomList : [roomList];
  t.to(list).emit(event, payload);
}

/** Fan out an order update to everyone who cares about it. */
export function emitOrderUpdate(order, event = 'order:updated') {
  const r = [rooms.order(order.id), rooms.restaurant(order.restaurant_id), rooms.ops];
  if (order.driver_id) r.push(rooms.driver(order.driver_id));
  emitTo(r, event, order);
}
