# One order, end to end

This follows a single order through FoodFlow and lists exactly what each step touches: HTTP call, SQL, Redis keys, socket events. If you can narrate this page from memory, you can answer most system-design follow-ups about the project.

Cast: customer **C** (`customer1`), kitchen **K** (`owner1`, restaurant 1), rider **R**, dispatch worker **W**.

---

## 0. Before anything happens

**API boot** (`server.js`)
- Runs `schema.sql` (idempotent `CREATE ... IF NOT EXISTS`).
- `rebuildDriverIndex()` reads every driver and restaurant from Postgres and rebuilds `geo:drivers`, `geo:restaurants` and the `driver:{id}` hashes. Redis can be flushed at any time and the system recovers on restart.
- Starts Socket.IO with the Redis adapter, the GPS flush timer, and (unless `EMBEDDED_WORKER=false`) the dispatch loop.

**Rider goes online**: `POST /api/drivers/me/status {status: ONLINE, lat, lng}`
- Postgres: `UPDATE drivers SET status='ONLINE', lat, lng`
- Redis: `HSET driver:R status ONLINE active 0 max 2 ...`, `GEOADD geo:drivers lng lat R`
- Socket: `driver:status` → `ops`

**Rider app streams GPS** every second: socket event `driver:location {lat, lng}`
- Server throttles to 1/s per socket.
- Redis: `GEOADD geo:drivers`, `HSET driver:locflush R "lat,lng"` (buffer)
- Every 10s one process `RENAME`s the buffer and writes all positions with a single `UPDATE drivers ... FROM unnest(...)`.

---

## 1. Customer browses

`GET /api/restaurants?lat=12.97&lng=77.59&radiusKm=5`
- Cache key `cache:nearby:12.97:77.59:5` (coords rounded to a ~1 km grid).
- Miss → `GEOSEARCH geo:restaurants FROMLONLAT ... BYRADIUS 5 km ASC WITHDIST` → one `SELECT ... WHERE id = ANY($1)` → stored for 30s ± jitter.

`GET /api/restaurants/1/menu`
- Cache key `cache:menu:1` (60s). Items carry `in_stock` (true/false), not the live number.
- Concurrent misses share one DB load (single-flight map in `cacheService.js`).

## 2. Customer places the order

`POST /api/orders` with header `Idempotency-Key: 7f3c…` (generated once per checkout attempt in the browser).

**Middleware chain:** `authenticate` (JWT) → `requireRole('CUSTOMER')` → `validate` (zod) → `idempotent`

**Idempotency middleware**
- `SET idem:orders:create:C:7f3c… {state: IN_PROGRESS, fp: sha256(body)} NX EX 30`
- Got the lock → continue. Didn't → replay / 409 / 422 (see README table).

**`placeOrder()` — one transaction**
```sql
BEGIN;
SELECT id, is_open, avg_prep_minutes FROM restaurants WHERE id = 1;
INSERT INTO orders (...) VALUES (...) ON CONFLICT (customer_id, idempotency_key) DO NOTHING RETURNING id;
-- for each item, ascending id:
UPDATE menu_items SET stock = stock - 2 WHERE id = 1 AND restaurant_id = 1 AND is_available AND stock >= 2 RETURNING ...;
INSERT INTO order_items (...);
UPDATE orders SET total_paise = 65000 WHERE id = $order;
INSERT INTO order_events (order_id, from_status, to_status, actor_role) VALUES ($order, NULL, 'PLACED', 'CUSTOMER');
COMMIT;
```
- Any item short → `409 OUT_OF_STOCK`, everything rolls back, including the order row.
- After commit: if an item hit 0, `DEL cache:menu:1`.
- Idempotency key overwritten with `{state: DONE, status: 201, body}` for 24h.

**Socket:** `order:new` → `restaurant:1`, `ops`
**Response:** `201` with the order. The browser navigates to `/orders/:id`.

## 3. Customer opens tracking

Socket `order:subscribe {orderId}` → server checks `orders.customer_id = C` → joins room `order:{id}`.

## 4. Kitchen accepts

The ticket appeared on K's rail from the `order:new` push. K clicks **Accept**:
`POST /api/orders/:id/transition {to: ACCEPTED}`

**`transitionOrder()`**
```sql
BEGIN;
SELECT * FROM orders WHERE id = $1 FOR UPDATE;          -- serialises racing transitions
-- authorisation: RESTAURANT must own restaurant_id
-- state machine: PLACED → ACCEPTED allowed for RESTAURANT
UPDATE orders SET status='ACCEPTED', version = version + 1,
       ready_by = now() + avg_prep_minutes ...           -- used by dispatch scoring
INSERT INTO order_events (...'PLACED','ACCEPTED','RESTAURANT'...);
COMMIT;
```
After commit:
- `ZADD dispatch:queue <now> $order` and `HSETNX dispatch:enqueued_at $order <now>`
- Socket `order:updated` → `order:{id}`, `restaurant:1`, `ops`. C's timeline ticks to "Accepted".

## 5. Dispatch

The worker loop runs every 100 ms (immediately again if the last batch was full).

**Claim due work** (Lua, atomic across workers):
```lua
local due = redis.call('ZRANGEBYSCORE', 'dispatch:queue', '-inf', now, 'LIMIT', 0, 50)
redis.call('ZREM', 'dispatch:queue', unpack(due))
return due
```

**`dispatchOrder(id)`**
1. `UPDATE orders o SET dispatch_attempts = +1, dispatch_state = 'SEARCHING' FROM restaurants r WHERE ... AND o.driver_id IS NULL AND o.status IN (ACCEPTED, PREPARING, READY) RETURNING ready_by, r.lat, r.lng` — skips orders that were cancelled or already assigned.
2. `SMEMBERS dispatch:exclude:{id}` — riders who declined this order.
3. `GEOSEARCH geo:drivers FROMLONLAT r.lng r.lat BYRADIUS 3 km ASC COUNT 25 WITHDIST`, then a pipelined `HGETALL driver:{id}` for each hit. Nobody eligible → 6 km → 10 km.
4. `rankCandidates()` — pure function, lowest cost wins (see README for weights).
5. **Claim**, top 3 candidates in order:
   ```sql
   BEGIN;
   UPDATE drivers SET active_orders = active_orders + 1, last_assigned_at = now()
    WHERE id = R AND status = 'ONLINE' AND active_orders < max_orders RETURNING id;
   UPDATE orders SET driver_id = R, dispatch_state = 'ASSIGNED', assigned_at = now()
    WHERE id = $order AND driver_id IS NULL AND status IN (...) RETURNING id;
   COMMIT;
   ```
   First update returns nothing → rider was taken by a parallel dispatch → try next.
   Second returns nothing → order was cancelled meanwhile → roll back, stop.
6. Redis mirror: `SADD driver:R:orders $order`, `HINCRBY driver:R active 1`, `HSET driver:R lastAssignedAt`.
7. `INSERT INTO dispatch_log (..., outcome='ASSIGNED', score, distance_m, eta_sec, candidates, radius_km)`
8. Sockets: `assignment:new` → `driver:R`; `order:updated` → order/kitchen/ops rooms.

No candidates → `ZADD dispatch:queue <now + 2s·2^(attempt-1)>`, log `NO_CANDIDATES`. After 8 attempts → `dispatch_state = 'FAILED'`, socket `dispatch:failed` → `ops`.

## 6. Rider rides to the kitchen

R's app receives `assignment:new`, draws the route, streams GPS. Each ping:
- `GEOADD geo:drivers`, buffer for DB flush
- `SMEMBERS driver:R:orders` → emit `driver:location` to `order:{id}` (C sees the dot move) and `ops`.

Meanwhile K moves the ticket **Start cooking → Mark ready** (same `transitionOrder()` path, `ACCEPTED → PREPARING → READY`).

If R clicks **Decline** before pickup: `POST /api/orders/:id/reject-assignment`
- Transaction: `orders.driver_id = NULL, dispatch_state = 'SEARCHING'`, `drivers.active_orders - 1`
- `SADD dispatch:exclude:{id} R` (1h TTL), `ZADD dispatch:queue now` → back to step 5 without R.

## 7. Pickup

R taps **Picked up**: `transition {to: PICKED_UP}`
- Allowed only from READY, only for role DRIVER, only for the assigned rider (`orders.driver_id = R`).
- C's map now routes rider → home instead of rider → kitchen.

## 8. Delivered

R taps **Delivered**: `transition {to: DELIVERED}`
```sql
UPDATE orders SET status='DELIVERED', delivered_at = now() ...;
INSERT INTO order_events (...);
UPDATE drivers SET active_orders = active_orders - 1 WHERE id = R AND active_orders > 0;   -- slot freed
```
After commit: `SREM driver:R:orders`, re-sync `driver:R` hash from Postgres, `ZREM dispatch:queue` (no-op), push `order:updated` everywhere.

The order now has six `order_events` rows: PLACED, ACCEPTED, PREPARING, READY, PICKED_UP, DELIVERED.

---

## Unhappy paths worth knowing

| What happens | Where it's handled | Result |
|---|---|---|
| Customer double-taps "Place order" | idempotency middleware | one order; second tap gets 409 in-progress or the replayed 201 |
| Phone retries after a timeout | idempotency middleware | replayed response, no second charge of stock |
| Redis restarted, key gone | `UNIQUE(customer_id, idempotency_key)` | `ON CONFLICT DO NOTHING`, existing order returned |
| 40 people order the last 5 biryanis | conditional `UPDATE ... stock >= qty` | exactly 5 succeed, 35 get `OUT_OF_STOCK` |
| Customer cancels while kitchen marks READY | `SELECT ... FOR UPDATE` | one wins, the other gets 409 invalid transition |
| Two workers pick the same rider | guarded `UPDATE drivers ... active_orders < max_orders` | one commits, the other tries its next candidate |
| Order cancelled mid-dispatch | guarded `UPDATE orders ... driver_id IS NULL AND status IN (...)` | claim rolls back, rider slot never taken |
| No riders nearby | ring expansion, then backoff retries | assigned when someone frees up, or FAILED + ops alert |
| Rider declines | `reject-assignment` + exclude set | re-dispatched to someone else |
| Kitchen rejects / cancels | `RESTOCK_ON` in state machine | stock returned, menu cache invalidated, rider freed |
| Deadlock between two transactions | `withTx()` | retried up to 3 times (Postgres codes 40P01 / 40001) |
| API process dies | stateless API, Redis adapter | clients reconnect to any process, rooms re-joined |

## Where to look in the code

| Concern | File |
|---|---|
| State machine | `backend/src/services/orderStateMachine.js` |
| Place / transition / decline | `backend/src/services/orderService.js` |
| Idempotency | `backend/src/middleware/idempotency.js` |
| Dispatch loop + claim | `backend/src/dispatch/dispatcher.js` |
| Scoring | `backend/src/dispatch/scoring.js` |
| Queue | `backend/src/dispatch/queue.js` |
| GPS + Redis mirror | `backend/src/services/driverService.js` |
| Cache | `backend/src/services/cacheService.js` |
| Sockets | `backend/src/realtime/socket.js`, `emitter.js` |
| Schema and constraints | `backend/src/db/schema.sql` |
