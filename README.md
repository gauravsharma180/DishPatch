# DishPatch

A real-time food delivery backend with a working frontend: customers order, kitchens cook, a dispatch engine picks the best nearby rider, and everyone watches the order move live.

**Stack:** Node.js, Express, PostgreSQL, Redis, Socket.IO, React (Vite), Leaflet

**What it does:** full order lifecycle as a state machine, geospatial rider matching with a scoring function, live tracking over websockets, idempotent order APIs, transactional inventory, Redis caching, and a load test that pushes 10,000 orders end to end and then proves nothing was double-counted.

```
                    ┌──────────── React app (customer / kitchen / rider / ops) ────────────┐
                    │                 REST /api/*            websocket (Socket.IO)         │
                    └───────────────────────┬────────────────────────┬────────────────────┘
                                            │                        │
                              ┌─────────────▼────────────────────────▼─────────────┐
                              │  Express API  (1..N processes, stateless, JWT)     │
                              │  routes → services → state machine                 │
                              │  idempotency middleware · cache-aside · metrics    │
                              └───────┬──────────────────────┬─────────────────────┘
                                      │                      │
             ┌────────────────────────▼───┐        ┌─────────▼──────────────────────────────┐
             │ PostgreSQL (source of truth)│        │ Redis                                  │
             │ orders, items, events,      │        │ geo:drivers / geo:restaurants (GEO)    │
             │ drivers (capacity CHECK),   │        │ driver:{id} hashes (dispatch mirror)   │
             │ menu stock (stock >= 0),    │        │ dispatch:queue (ZSET, delayed retries) │
             │ dispatch_log                │        │ idem:* (Idempotency-Key responses)     │
             └────────────▲────────────────┘        │ cache:menu / cache:nearby              │
                          │                         │ Socket.IO adapter pub/sub              │
             ┌────────────┴────────────────┐        └─────────▲──────────────────────────────┘
             │ Dispatch worker (1..N)      │──────────────────┘
             │ claim due → GEOSEARCH →     │
             │ score → atomic SQL claim    │
             └─────────────────────────────┘
```

Rule of thumb used everywhere: **Redis is for speed, Postgres is for truth.** Redis answers "who is near this restaurant" in microseconds; Postgres decides "can this rider actually take this order" with a guarded `UPDATE`. If Redis is wiped, the API rebuilds its indexes from Postgres on boot.

---

## Run it locally (no Docker)

You need **Node 20+**, **PostgreSQL 14+** and **Redis 6.2+** (for `GEOSEARCH`).

<details>
<summary>Installing Postgres + Redis</summary>

- **Ubuntu / WSL:** `sudo apt install postgresql redis-server && sudo service postgresql start && sudo service redis-server start`
- **macOS:** `brew install postgresql@16 redis && brew services start postgresql@16 && brew services start redis`
- **Windows:** easiest is WSL (Ubuntu) and the commands above. Redis has no official native Windows build.
</details>

```bash
# 1. database + user (once)
sudo -u postgres psql -c "CREATE USER dishpatch WITH PASSWORD 'dishpatch' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE dishpatch OWNER dishpatch;"
sudo -u postgres psql -c "CREATE DATABASE dishpatch_test OWNER dishpatch;"   # for npm test

# 2. backend
cd backend
cp .env.example .env
npm install
npm run seed          # 40 restaurants, 50 riders, 500 customers around central Bengaluru
npm run dev           # API + embedded dispatch worker on :4000

# 3. frontend (new terminal)
cd frontend
npm install
npm run dev           # http://localhost:5173

# 4. bring the city to life (new terminal, optional)
cd backend
npm run sim -- --speed 10 --kitchens --customers 1
```

Open http://localhost:5173 and pick a demo seat. All passwords are `password123`.

| Login | Sees |
|---|---|
| `customer1@dishpatch.dev` | nearby kitchens, menu, cart, live order tracking with rider on the map |
| `owner1@dishpatch.dev` | kitchen ticket rail (New → Cooking → Ready → With rider), stock editor |
| `driver1@dishpatch.dev` | online/offline, assigned jobs, pickup/deliver, simulated GPS riding |
| `admin@dishpatch.dev` | live fleet map, orders by stage, every dispatch decision with its score |

The simulator drives riders 2–50 and leaves `driver1` for you, so you can take real assignments from the rider screen while the rest of the city runs itself.

### Tests

```bash
cd backend && npm test      # 22 tests: unit (scoring, state machine, geo) + integration on real Postgres/Redis
```

The integration tests are the interesting ones: 40 customers racing for 5 plates, 10 concurrent duplicate requests with one key, 4 orders racing for one rider with capacity 1, rider declines and re-dispatch, cancellation restocking.

### Load test

```bash
cd loadtest && npm install
npm run seed                 # 100 restaurants, 1,000 riders, 2,000 customers
npm test                     # 10,000 orders through the full lifecycle, then invariant checks
```

Results and how to read them: [loadtest/RESULTS.md](loadtest/RESULTS.md).

### Multi-core mode

```bash
npm run start:cluster        # WEB_CONCURRENCY workers sharing :4000
npm run worker               # or run dispatch separately (set EMBEDDED_WORKER=false on API nodes)
```

---

## Order lifecycle

```
PLACED ──accept──▶ ACCEPTED ──▶ PREPARING ──▶ READY ──pickup──▶ PICKED_UP ──▶ DELIVERED
  │                   │             │
  ├─reject─▶ REJECTED └──cancel─────┴──▶ CANCELLED
  └─cancel─▶ CANCELLED
```

- Each edge lists which roles may take it (`services/orderStateMachine.js`). The customer can cancel only before the kitchen accepts; only the assigned rider can mark pickup.
- Rider assignment is a **separate field** (`dispatch_state`: PENDING → SEARCHING → ASSIGNED / FAILED). Dispatch starts the moment the kitchen accepts, so the rider travels while the food cooks.
- Every transition writes an `order_events` row. REJECTED/CANCELLED put stock back. Terminal states free the rider's slot.
- Re-sending the current status is a no-op, so a flaky mobile client can retry safely.

Full step-by-step trace of one order (every table row, Redis key and socket event): **[docs/WORKFLOW.md](docs/WORKFLOW.md)**.

## Dispatch engine

1. Kitchen accepts → order ID goes into `dispatch:queue` (Redis sorted set, score = due time).
2. Worker pops due orders with a Lua script (atomic, so N workers never double-process).
3. `GEOSEARCH` riders around the restaurant in rings of 3 → 6 → 10 km, max 25 candidates per ring.
4. Filter to online riders under capacity, then rank with a pure cost function (`dispatch/scoring.js`):

   | Component | Weight | Meaning |
   |---|---|---|
   | distance | 0.40 | metres to restaurant / ring radius |
   | ETA fit | 0.35 | how far the rider's arrival misses the food-ready time; **late costs 4× more than early** |
   | workload | 0.25 | orders in hand / capacity, plus 4 min time penalty per order carried |
   | fairness | −0.05 max | small bonus for riders who haven't had an order in a while |

5. **Claim** the best rider in one Postgres transaction:
   `UPDATE drivers SET active_orders = active_orders + 1 WHERE id = $1 AND status = 'ONLINE' AND active_orders < max_orders` and
   `UPDATE orders SET driver_id = $2 WHERE id = $1 AND driver_id IS NULL AND status IN (...)`.
   If either guard fails (another worker got there first, or the order was cancelled) the transaction rolls back and the next-best rider is tried.
6. Nobody available → retry with exponential backoff (2s, 4s, 8s … capped at 30s), mark FAILED after 8 attempts and alert ops.
7. Every decision is written to `dispatch_log` (score, distance, ETA, candidates, radius) so the weights can be tuned offline.

## Idempotency and inventory

**Placing an order** needs an `Idempotency-Key` header (the frontend generates one per checkout attempt):

| Situation | Response |
|---|---|
| first request | runs normally, response saved in Redis for 24h |
| retry after it finished | saved response replayed, header `Idempotent-Replayed: true`, handler never runs |
| retry while first is still running | `409 REQUEST_IN_PROGRESS` + `Retry-After: 1` |
| same key, different body | `422 IDEMPOTENCY_KEY_REUSED` (client bug, not a retry) |
| handler crashed (5xx) | key deleted so the client can retry |
| Redis lost the key | `UNIQUE(customer_id, idempotency_key)` in Postgres catches it, returns the existing order |

**Stock** is reserved inside the same transaction that creates the order, with a conditional decrement:

```sql
UPDATE menu_items SET stock = stock - $qty
 WHERE id = $id AND restaurant_id = $rid AND is_available AND stock >= $qty
RETURNING ...
```

No row returned = out of stock = whole order rolls back. Items are locked in ascending id order so two orders sharing items can't deadlock, and `CHECK (stock >= 0)` is the last line of defence.

## Caching

- **Menus** (`cache:menu:{id}`, 60s): cache-aside with single-flight (concurrent misses share one DB query) and TTL jitter. Shows only in-stock / sold-out, never the live count, because the real check happens in the order transaction. Invalidated on menu edits, when an item hits zero, and on restock.
- **Nearby restaurants** (`cache:nearby:{grid cell}`, 30s): coordinates are snapped to a ~1 km grid so nearby users share entries.
- Hit/miss counters are exposed on `/metrics`.

## Real-time

- Socket rooms: `order:{id}`, `restaurant:{id}`, `driver:{id}`, `ops`. JWT is checked on the handshake; joining an order room checks ownership.
- Rider GPS pings (throttled to 1/s per rider) update Redis GEO and fan out to the rider's active order rooms. Positions are batch-flushed to Postgres every 10s with one `UPDATE … FROM unnest(...)` instead of a write per ping.
- The Socket.IO Redis adapter lets any API process (or the standalone dispatch worker, via the Redis emitter) push to any connected client.

## API

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | anyone | returns JWT |
| POST | `/api/auth/register` | anyone | creates a customer |
| GET | `/api/restaurants?lat&lng&radiusKm` | anyone | Redis GEO + cache |
| GET | `/api/restaurants/:id/menu` | anyone | cached |
| GET | `/api/restaurants/:id/inventory` | kitchen | live stock |
| PATCH | `/api/restaurants/:id` | kitchen | open/close, prep time |
| PATCH | `/api/restaurants/:id/menu/:itemId` | kitchen | stock/price/availability, invalidates cache |
| POST | `/api/orders` | customer | **requires `Idempotency-Key`** |
| GET | `/api/orders` | any | scoped to the caller's role |
| GET | `/api/orders/:id` | owner/kitchen/rider/admin | includes event trail |
| POST | `/api/orders/:id/transition` | role-checked | `{ "to": "ACCEPTED" }` |
| POST | `/api/orders/:id/reject-assignment` | rider | re-dispatches, excluding this rider |
| GET | `/api/drivers/me` | rider | profile + active orders |
| POST | `/api/drivers/me/status` | rider | ONLINE / OFFLINE |
| POST | `/api/drivers/me/location` | rider | also available as a socket event |
| GET | `/api/admin/overview`, `/drivers/live`, `/dispatch-log` | admin | ops dashboard |
| GET | `/health`, `/metrics` | infra | Prometheus format |

## Project layout

```
backend/
  src/
    app.js, server.js, cluster.js
    config.js
    db/            schema.sql, migrate.js, seed.js, pool.js (withTx + retry on deadlock)
    middleware/    auth (JWT + roles), idempotency, validate (zod)
    services/      orderService, orderStateMachine, driverService, cacheService
    dispatch/      queue (Redis ZSET + Lua), scoring (pure), dispatcher, worker
    realtime/      socket.js (rooms, auth, GPS), emitter.js (works with or without a socket server)
    sim/           driverSimulator.js (riders, kitchens, customers)
  tests/           unit.test.js, api.test.js
frontend/
  src/pages/       Login, Customer, Track, Kitchen, Rider, Ops
  src/components/  CityMap (Leaflet), Ticket, Timeline
loadtest/          loadtest.js, results/, RESULTS.md
docs/              WORKFLOW.md, INTERVIEW.md
```

## Known limits / what I'd do next

- ETA is straight-line distance × 1.35 road factor at a fixed speed. A real system calls a routing engine (OSRM/Valhalla) and learns per-zone speeds by time of day.
- Dispatch is greedy, one order at a time. Batch assignment (collect orders for ~2s, solve as a bipartite matching problem) gives better global results at peak.
- No true order batching yet (one rider picking two orders from the same kitchen gets no bonus).
- The dispatch queue is a Redis ZSET; at higher scale I'd move to Kafka/SQS with an outbox table so "order accepted" and "enqueue dispatch" commit atomically.
- No payments, no surge pricing, no rider acceptance timeout (assignment is auto-accepted; riders can decline).
