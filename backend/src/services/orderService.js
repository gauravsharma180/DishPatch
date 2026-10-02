import { query, withTx } from '../db/pool.js';
import { redis, keys } from '../lib/redis.js';
import { AppError, conflict, forbidden, notFound, badRequest } from '../lib/errors.js';
import { canTransition, RESTOCK_ON, TERMINAL } from './orderStateMachine.js';
import { invalidateMenu } from './cacheService.js';
import { syncDriverMirror } from './driverService.js';
import { emitOrderUpdate, emitTo, rooms } from '../realtime/emitter.js';
import { enqueueDispatch, cancelDispatch } from '../dispatch/queue.js';
import { ordersCreated, ordersRejected, transitions } from '../lib/metrics.js';

const ORDER_COLS = `o.id, o.customer_id, o.restaurant_id, o.driver_id, o.status, o.dispatch_state,
  o.total_paise, o.delivery_lat, o.delivery_lng, o.delivery_address, o.version, o.ready_by,
  o.assigned_at, o.delivered_at, o.created_at, o.updated_at,
  COALESCE((SELECT json_agg(json_build_object('menu_item_id', oi.menu_item_id, 'name', oi.name,
            'qty', oi.qty, 'price_paise', oi.price_paise) ORDER BY oi.menu_item_id)
            FROM order_items oi WHERE oi.order_id = o.id), '[]') AS items`;

/**
 * Place an order.
 *
 * Inside ONE transaction:
 *   1. INSERT the order guarded by UNIQUE(customer_id, idempotency_key). If a concurrent
 *      duplicate already committed, we return that order and touch no stock.
 *   2. Decrement stock with a conditional UPDATE (`stock >= qty`). This is atomic per row,
 *      so two customers racing for the last plate can't both win. Items are locked in
 *      ascending id order so two orders sharing items can't deadlock.
 *   3. Write order_items + the first lifecycle event.
 * Any failure rolls back everything, so we never have stock reserved for a missing order.
 */
export async function placeOrder(user, input, idempotencyKey) {
  const lines = mergeLines(input.items);

  const result = await withTx(async (db) => {
    const { rows: [restaurant] } = await db.query(
      'SELECT id, is_open, avg_prep_minutes FROM restaurants WHERE id=$1',
      [input.restaurantId],
    );
    if (!restaurant) throw notFound('Restaurant not found');
    if (!restaurant.is_open) throw conflict('RESTAURANT_CLOSED', 'Restaurant is not accepting orders');

    const { rows: [created] } = await db.query(
      `INSERT INTO orders (customer_id, restaurant_id, total_paise, delivery_lat, delivery_lng,
                           delivery_address, idempotency_key)
       VALUES ($1,$2,0,$3,$4,$5,$6)
       ON CONFLICT (customer_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [user.id, input.restaurantId, input.deliveryLat, input.deliveryLng, input.address ?? null, idempotencyKey],
    );
    if (!created) {
      const { rows: [existing] } = await db.query(
        'SELECT id FROM orders WHERE customer_id=$1 AND idempotency_key=$2',
        [user.id, idempotencyKey],
      );
      return { orderId: existing.id, duplicate: true };
    }

    let total = 0;
    const soldOut = [];
    for (const line of lines) {
      const { rows: [item] } = await db.query(
        `UPDATE menu_items SET stock = stock - $2, updated_at = now()
          WHERE id = $1 AND restaurant_id = $3 AND is_available AND stock >= $2
          RETURNING id, name, price_paise, stock`,
        [line.menuItemId, line.qty, input.restaurantId],
      );
      if (!item) {
        const { rows: [cur] } = await db.query(
          'SELECT id, name, stock, is_available FROM menu_items WHERE id=$1 AND restaurant_id=$2',
          [line.menuItemId, input.restaurantId],
        );
        if (!cur) throw badRequest(`Menu item ${line.menuItemId} does not belong to this restaurant`);
        throw conflict('OUT_OF_STOCK', `${cur.name} is out of stock`, {
          menuItemId: cur.id,
          requested: line.qty,
          available: cur.is_available ? cur.stock : 0,
        });
      }
      if (item.stock === 0) soldOut.push(item.id);
      total += item.price_paise * line.qty;
      await db.query(
        'INSERT INTO order_items (order_id, menu_item_id, name, qty, price_paise) VALUES ($1,$2,$3,$4,$5)',
        [created.id, item.id, item.name, line.qty, item.price_paise],
      );
    }

    await db.query('UPDATE orders SET total_paise=$2 WHERE id=$1', [created.id, total]);
    await db.query(
      `INSERT INTO order_events (order_id, from_status, to_status, actor_role, actor_id)
       VALUES ($1, NULL, 'PLACED', 'CUSTOMER', $2)`,
      [created.id, user.id],
    );
    return { orderId: created.id, duplicate: false, soldOut };
  }).catch((err) => {
    if (err instanceof AppError) ordersRejected.inc({ reason: err.code });
    throw err;
  });

  const order = await getOrderRow(result.orderId);
  if (!result.duplicate) {
    ordersCreated.inc();
    if (result.soldOut.length) await invalidateMenu(order.restaurant_id);
    emitTo([rooms.restaurant(order.restaurant_id), rooms.ops], 'order:new', order);
  }
  return { order, duplicate: result.duplicate };
}

function mergeLines(items) {
  const byId = new Map();
  for (const { menuItemId, qty } of items) byId.set(menuItemId, (byId.get(menuItemId) || 0) + qty);
  return [...byId.entries()].map(([menuItemId, qty]) => ({ menuItemId, qty })).sort((a, b) => a.menuItemId - b.menuItemId);
}

/** Who is allowed to act on this order at all (state machine then decides which transitions). */
function assertCanAct(order, user) {
  switch (user.role) {
    case 'ADMIN':
      return;
    case 'CUSTOMER':
      if (order.customer_id !== user.id) throw forbidden('Not your order');
      return;
    case 'RESTAURANT':
      if (order.restaurant_id !== user.restaurantId) throw forbidden('Not your restaurant');
      return;
    case 'DRIVER':
      if (order.driver_id !== user.driverId) throw forbidden('Order not assigned to you');
      return;
    default:
      throw forbidden();
  }
}

/**
 * Move an order to a new status.
 * Row lock (SELECT ... FOR UPDATE) serialises concurrent transitions on the same order,
 * e.g. a customer cancelling at the same instant the kitchen marks it READY.
 * Re-sending the current status is a no-op (safe retries from flaky mobile clients).
 */
export async function transitionOrder(orderId, to, user, note) {
  const out = await withTx(async (db) => {
    const { rows: [order] } = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!order) throw notFound('Order not found');
    assertCanAct(order, user);

    if (order.status === to) return { order, changed: false };

    const check = canTransition(order.status, to, user.role);
    if (!check.ok) {
      throw conflict(check.reason, `Cannot move order from ${order.status} to ${to} as ${user.role}`, {
        from: order.status,
        to,
      });
    }
    if (to === 'PICKED_UP' && !order.driver_id) throw conflict('NO_DRIVER', 'No driver assigned yet');

    const { rows: [updated] } = await db.query(
      `UPDATE orders SET status=$2, version=version+1, updated_at=now(),
              ready_by = CASE WHEN $2::order_status='ACCEPTED'
                              THEN now() + make_interval(mins => (SELECT avg_prep_minutes FROM restaurants WHERE id=restaurant_id))
                              ELSE ready_by END,
              delivered_at = CASE WHEN $2::order_status='DELIVERED' THEN now() ELSE delivered_at END,
              dispatch_state = CASE WHEN $2::order_status IN ('CANCELLED','REJECTED') AND dispatch_state <> 'ASSIGNED'
                                    THEN 'FAILED'::dispatch_state ELSE dispatch_state END
        WHERE id=$1 RETURNING *`,
      [orderId, to],
    );
    await db.query(
      `INSERT INTO order_events (order_id, from_status, to_status, actor_role, actor_id, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orderId, order.status, to, user.role, user.id, note ?? null],
    );

    let restocked = false;
    if (RESTOCK_ON.has(to)) {
      await db.query(
        `UPDATE menu_items m SET stock = m.stock + oi.qty, updated_at=now()
           FROM (SELECT menu_item_id, qty FROM order_items WHERE order_id=$1 ORDER BY menu_item_id) oi
          WHERE m.id = oi.menu_item_id`,
        [orderId],
      );
      restocked = true;
    }

    let releasedDriver = null;
    if (TERMINAL.has(to) && order.driver_id) {
      await db.query('UPDATE drivers SET active_orders = active_orders - 1 WHERE id=$1 AND active_orders > 0', [
        order.driver_id,
      ]);
      releasedDriver = order.driver_id;
    }
    return { order: updated, changed: true, restocked, releasedDriver, from: order.status };
  });

  if (out.changed) {
    transitions.inc({ to });
    const o = out.order;
    if (out.restocked) await invalidateMenu(o.restaurant_id);
    if (out.releasedDriver) {
      await redis.srem(keys.driverOrders(out.releasedDriver), o.id);
      await syncDriverMirror(out.releasedDriver);
    }
    if (to === 'ACCEPTED') await enqueueDispatch(o.id);
    if (TERMINAL.has(to)) await cancelDispatch(o.id);
  }
  const fresh = await getOrderRow(out.order.id);
  if (out.changed) emitOrderUpdate(fresh, 'order:updated');
  return fresh;
}

/** Driver declines an assignment before pickup: free their slot, re-dispatch excluding them. */
export async function rejectAssignment(orderId, user) {
  const order = await withTx(async (db) => {
    const { rows: [o] } = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!o) throw notFound('Order not found');
    if (o.driver_id !== user.driverId) throw forbidden('Order not assigned to you');
    if (!['ACCEPTED', 'PREPARING', 'READY'].includes(o.status)) {
      throw conflict('INVALID_TRANSITION', 'Cannot reject after pickup');
    }
    await db.query(
      `UPDATE orders SET driver_id=NULL, dispatch_state='SEARCHING', assigned_at=NULL, version=version+1, updated_at=now()
        WHERE id=$1`,
      [orderId],
    );
    await db.query('UPDATE drivers SET active_orders = active_orders - 1 WHERE id=$1 AND active_orders > 0', [
      user.driverId,
    ]);
    return o;
  });
  await redis.multi()
    .srem(keys.driverOrders(user.driverId), orderId)
    .sadd(keys.dispatchExclude(orderId), String(user.driverId))
    .expire(keys.dispatchExclude(orderId), 3600)
    .exec();
  await syncDriverMirror(user.driverId);
  await enqueueDispatch(orderId);
  const fresh = await getOrderRow(orderId);
  emitOrderUpdate(fresh, 'order:updated');
  emitTo(rooms.driver(user.driverId), 'assignment:removed', { orderId });
  return fresh;
}

export async function getOrderRow(orderId) {
  const { rows: [o] } = await query(
    `SELECT ${ORDER_COLS}, r.name AS restaurant_name, r.lat AS restaurant_lat, r.lng AS restaurant_lng,
            d.name AS driver_name, d.vehicle AS driver_vehicle, d.lat AS driver_lat, d.lng AS driver_lng
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN drivers d ON d.id = o.driver_id
      WHERE o.id=$1`,
    [orderId],
  );
  return o || null;
}

export async function getOrderDetail(orderId, user) {
  const order = await getOrderRow(orderId);
  if (!order) throw notFound('Order not found');
  assertCanAct(order, user);
  const { rows: events } = await query(
    'SELECT from_status, to_status, actor_role, note, created_at FROM order_events WHERE order_id=$1 ORDER BY id',
    [orderId],
  );
  return { ...order, events };
}

export async function listOrders(user, { status, limit = 50 } = {}) {
  const params = [];
  const where = [];
  if (user.role === 'CUSTOMER') {
    params.push(user.id);
    where.push(`o.customer_id=$${params.length}`);
  } else if (user.role === 'RESTAURANT') {
    params.push(user.restaurantId);
    where.push(`o.restaurant_id=$${params.length}`);
  } else if (user.role === 'DRIVER') {
    params.push(user.driverId);
    where.push(`o.driver_id=$${params.length}`);
  }
  if (status) {
    const list = status.split(',');
    params.push(list);
    where.push(`o.status = ANY($${params.length}::order_status[])`);
  }
  params.push(Math.min(Number(limit) || 50, 200));
  const { rows } = await query(
    `SELECT ${ORDER_COLS}, r.name AS restaurant_name, r.lat AS restaurant_lat, r.lng AS restaurant_lng,
            d.name AS driver_name
       FROM orders o JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN drivers d ON d.id=o.driver_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}
