# Dishpatch

**A real-time food delivery and rider dispatch engine that never double-books a rider or oversells a dish.**

---

## About

Food delivery breaks in a few predictable places. Two customers try to buy the last plate, a phone on a bad network retries and places the same order twice, or two dispatch workers hand the same rider more orders than they can carry. Dishpatch is a full delivery backend built to handle those races correctly. It also chooses riders well, picking the one whose arrival lines up with the moment the food is ready.

It covers the whole flow: customers order, kitchens cook, a dispatch engine picks the best nearby rider, and everyone watches the order move live on a map.

**Stack:** Node.js, Express, PostgreSQL, Redis, Socket.IO, React (Vite), Leaflet

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

Rule of thumb used everywhere: **Redis is for speed, Postgres is for truth.** Redis answers "who is near this restaurant" in microseconds. Postgres decides "can this rider actually take this order" with a guarded `UPDATE`.

## Table of contents

- [Results](#results)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [How it works](#how-it-works)
- [API reference](#api-reference)
- [Project layout](#project-layout)
- [Known limits and roadmap](#known-limits-and-roadmap)
- [Contributing](#contributing)

## Results

Load-tested with 10,000 full order lifecycles through the real HTTP API and websockets, then checked directly in Postgres:

| Metric | Result |
|---|---|
| Orders delivered end to end | **9,754 / 10,000** (246 correctly rejected as sold out) |
| Failed flows | **0** |
| Duplicate orders under a retry storm | **0** |
| Flash-sale dish with 300 units | **sold exactly 300** |
| Riders ever over capacity | **0** |
| p95 order placement / rider assignment | **68 ms / 222 ms** (20 concurrent flows) |

Everything ran on one 2 vCPU VM shared by the API, Postgres, Redis and the load generator. Full numbers: [loadtest/RESULTS.md](loadtest/RESULTS.md).

## Features

- **Dispatch engine:** Redis `GEOSEARCH` in expanding 3 / 6 / 10 km rings, a pure scoring function (distance, ETA vs food-ready time, workload), and a guarded SQL claim so parallel workers never overload a rider.
- **Idempotent ordering:** an `Idempotency-Key` on every order, stored in Redis with a Postgres unique-key backstop.
- **Transactional inventory:** stock reserved in the same transaction as the order, with a conditional decrement and deadlock-free lock ordering.
- **Live tracking:** status changes and rider GPS pushed over Socket.IO rooms, scaled across processes with the Redis adapter.
- **Caching:** cache-aside menus with single-flight and TTL jitter, plus grid-snapped nearby-restaurant lookups.
- **Observability:** every dispatch decision logged with its score, and Prometheus metrics on `/metrics`.
- **Four apps in one frontend:**

  | Role | What you see |
  |---|---|
  | Customer | nearby kitchens, menu, cart, live tracking with the rider on the map |
  | Kitchen | ticket rail (New → Cooking → Ready → With rider), stock editor |
  | Rider | go online, take assignments, pick up and deliver, simulated GPS |
  | Ops | live fleet map, orders by stage, every dispatch decision with its score |

## Installation

### Prerequisites

- **Node.js 20+**
- **PostgreSQL 14+**
- **Redis 6.2+** (needed for `GEOSEARCH`)

<details>
<summary>Installing Postgres and Redis</summary>

```bash
# Ubuntu / WSL
sudo apt install postgresql redis-server
sudo service postgresql start && sudo service redis-server start

# macOS
brew install postgresql@16 redis
brew services start postgresql@16 && brew services start redis
```

On Windows, use WSL (Ubuntu) and the commands above. Redis has no official native Windows build.
</details>

### Setup

1. Create a Postgres user and two databases: `dishpatch`, and `dishpatch_test` for the test suite.

2. Install and seed the backend:
   ```bash
   cd backend
   cp .env.example .env    # set DATABASE_URL, REDIS_URL and JWT_SECRET for your setup
   npm install
   npm run seed            # 40 restaurants, 50 riders, 500 customers around central Bengaluru
   ```

3. Install the frontend:
   ```bash
   cd frontend
   npm install
   ```

## Usage

### Run the app

```bash
# terminal 1: API + embedded dispatch worker
cd backend && npm run dev

# terminal 2: frontend dev server
cd frontend && npm run dev

# terminal 3 (optional): bring the city to life
cd backend && npm run sim -- --speed 10 --kitchens --customers 1
```

Open the frontend in your browser and pick a role. The simulator drives every rider except the first, so you can take real assignments yourself while the rest of the city runs.

### Call the API directly

Set `API` to the address your backend is running on, then:

```bash
# log in with a seeded account and keep the token
TOKEN=$(curl -s $API/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<email>","password":"<password>"}' | jq -r .token)

# find restaurants near a point
curl -s "$API/api/restaurants?lat=12.9716&lng=77.5946&radiusKm=5"

# see a restaurant's menu (use its item ids below)
curl -s $API/api/restaurants/1/menu

# place an order (send the same Idempotency-Key again and you get the same order back)
curl -s $API/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"restaurantId":1,"items":[{"menuItemId":1,"qty":2}],"deliveryLat":12.97,"deliveryLng":77.59}'
```

### Run the tests

```bash
cd backend && npm test   # 22 tests: unit (scoring, state machine, geo) + integration on real Postgres and Redis
```

The integration tests cover the races: 40 customers competing for 5 plates, 10 concurrent duplicates with one key, 4 orders competing for one rider with capacity 1, a rider declining and re-dispatch, and cancellation restocking.

### Run the load test

```bash
cd loadtest && npm install
npm run seed     # 100 restaurants, 1,000 riders, 2,000 customers
npm test         # 10,000 orders through the full lifecycle, then invariant checks in Postgres
```

### Run on multiple cores

```bash
npm run start:cluster    # WEB_CONCURRENCY workers sharing one port
npm run worker           # or run dispatch separately (set EMBEDDED_WORKER=false on API nodes)
```

## How it works

### Order lifecycle

```
PLACED ──accept──▶ ACCEPTED ──▶ PREPARING ──▶ READY ──pickup──▶ PICKED_UP ──▶ DELIVERED
  │                   │             │
  ├─reject─▶ REJECTED └──cancel─────┴──▶ CANCELLED
  └─cancel─▶ CANCELLED
```

- Each transition lists which roles may take it (`services/orderStateMachine.js`). Customers can cancel only before the kitchen accepts. Only the assigned rider can mark pickup.
- Rider assignment is tracked separately (`dispatch_state`: PENDING → SEARCHING → ASSIGNED / FAILED). Dispatch starts when the kitchen accepts, so the rider travels while the food cooks.
- Every transition writes an `order_events` row. Rejected and cancelled orders put stock back. Terminal states free the rider's slot.
- Re-sending the current status is a no-op, so a flaky client can retry safely.

A step-by-step trace of one order (every table row, Redis key and socket event): [docs/WORKFLOW.md](docs/WORKFLOW.md).

### Dispatch engine

1. Kitchen accepts → order ID goes into `dispatch:queue` (Redis sorted set, score = due time).
2. A worker pops due orders with a Lua script, so N workers never process the same order.
3. `GEOSEARCH` finds riders around the restaurant in rings of 3 → 6 → 10 km, up to 25 candidates per ring.
4. Keep online riders under capacity, then rank them with a pure cost function (`dispatch/scoring.js`):

   | Component | Weight | Meaning |
   |---|---|---|
   | distance | 0.40 | metres to restaurant / ring radius |
   | ETA fit | 0.35 | gap between rider arrival and food-ready time; **late costs 4× more than early** |
   | workload | 0.25 | orders in hand / capacity, plus a 4 min penalty per order carried |
   | fairness | −0.05 max | small bonus for riders who haven't had an order in a while |

5. **Claim** the best rider in one Postgres transaction:
   ```sql
   UPDATE drivers SET active_orders = active_orders + 1
    WHERE id = $1 AND status = 'ONLINE' AND active_orders < max_orders;

   UPDATE orders SET driver_id = $2
    WHERE id = $1 AND driver_id IS NULL AND status IN (...);
   ```
   If either guard fails (another worker won, or the order was cancelled), the transaction rolls back and the next-best rider is tried.
6. If nobody is available, retry with exponential backoff (2s, 4s, 8s … capped at 30s). After 8 attempts, mark the order FAILED and alert ops.
7. Every decision is logged to `dispatch_log` (score, distance, ETA, candidates, radius) so the weights can be tuned offline.

### Idempotency

| Situation | Response |
|---|---|
| first request | runs normally, response saved in Redis for 24h |
| retry after it finished | saved response replayed with `Idempotent-Replayed: true`, handler never runs |
| retry while the first is still running | `409 REQUEST_IN_PROGRESS` + `Retry-After: 1` |
| same key, different body | `422 IDEMPOTENCY_KEY_REUSED` |
| handler crashed (5xx) | key deleted so the client can retry |
| Redis lost the key | `UNIQUE(customer_id, idempotency_key)` in Postgres returns the existing order |

### Inventory

Stock is reserved inside the order transaction:

```sql
UPDATE menu_items SET stock = stock - $qty
 WHERE id = $id AND restaurant_id = $rid AND is_available AND stock >= $qty
RETURNING ...
```

No row returned means out of stock, and the whole order rolls back. Items are locked in ascending id order so two orders sharing items can't deadlock. `CHECK (stock >= 0)` is the last line of defence.

### Caching

- **Menus** (`cache:menu:{id}`, 60s): cache-aside with single-flight (concurrent misses share one DB query) and TTL jitter. The cache shows only in stock / sold out, never the live count, because the real check happens in the order transaction.
- **Nearby restaurants** (`cache:nearby:{grid cell}`, 30s): coordinates snap to a ~1 km grid so nearby users share entries.

### Real-time

- Socket rooms: `order:{id}`, `restaurant:{id}`, `driver:{id}`, `ops`. JWT is checked on the handshake, and joining an order room checks ownership.
- Rider GPS pings (throttled to 1/s per rider) update Redis GEO and fan out to the rider's active order rooms. Positions are batch-flushed to Postgres every 10s with a single `UPDATE … FROM unnest(...)`.
- The Socket.IO Redis adapter lets any API process, or the standalone dispatch worker via the Redis emitter, push to any connected client.

## API reference

<details>
<summary>All endpoints</summary>

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | anyone | returns JWT |
| POST | `/api/auth/register` | anyone | creates a customer |
| GET | `/api/restaurants?lat&lng&radiusKm` | anyone | Redis GEO + cache |
| GET | `/api/restaurants/:id/menu` | anyone | cached |
| GET | `/api/restaurants/:id/inventory` | kitchen | live stock |
| PATCH | `/api/restaurants/:id` | kitchen | open/close, prep time |
| PATCH | `/api/restaurants/:id/menu/:itemId` | kitchen | stock, price, availability; invalidates cache |
| POST | `/api/orders` | customer | **requires `Idempotency-Key`** |
| GET | `/api/orders` | any | scoped to the caller's role |
| GET | `/api/orders/:id` | owner / kitchen / rider / admin | includes event trail |
| POST | `/api/orders/:id/transition` | role-checked | `{ "to": "ACCEPTED" }` |
| POST | `/api/orders/:id/reject-assignment` | rider | re-dispatches, excluding this rider |
| GET | `/api/drivers/me` | rider | profile + active orders |
| POST | `/api/drivers/me/status` | rider | ONLINE / OFFLINE |
| POST | `/api/drivers/me/location` | rider | also available as a socket event |
| GET | `/api/admin/overview`, `/drivers/live`, `/dispatch-log` | admin | ops dashboard |
| GET | `/health`, `/metrics` | infra | Prometheus format |

</details>

## Project layout

```
backend/
  src/
    app.js, server.js, cluster.js, config.js
    db/            schema.sql, migrate.js, seed.js, pool.js (withTx + retry on deadlock)
    middleware/    auth (JWT + roles), idempotency, validate (zod)
    services/      orderService, orderStateMachine, driverService, cacheService
    dispatch/      queue (Redis ZSET + Lua), scoring (pure), dispatcher, worker
    realtime/      socket.js (rooms, auth, GPS), emitter.js
    sim/           driverSimulator.js (riders, kitchens, customers)
  tests/           unit.test.js, api.test.js
frontend/
  src/pages/       Login, Customer, Track, Kitchen, Rider, Ops
  src/components/  CityMap (Leaflet), Ticket, Timeline
loadtest/          loadtest.js, results/, RESULTS.md
docs/              WORKFLOW.md
```

## Known limits and roadmap

- **ETA** is straight-line distance × 1.35 road factor at a fixed speed. Next step: a routing engine (OSRM or Valhalla) and per-zone speeds by time of day.
- **Dispatch is greedy**, one order at a time. Batching orders for ~2s and solving it as bipartite matching gives better results at peak.
- **No order batching** yet: one rider picking up two orders from the same kitchen gets no bonus.
- **Enqueue happens after the DB commit**, so a crash between them can drop a dispatch. Fix: a transactional outbox, or a sweeper for accepted orders with no rider and no queue entry. At higher scale the queue would move to Kafka or SQS.
- **Not in scope:** payments, surge pricing, and a rider acceptance timeout (assignment is auto-accepted; riders can decline).

## Contributing

Issues and pull requests are welcome.

1. Fork the repo and create a branch: `git checkout -b feature/your-change`
2. Make your change and add tests for new behaviour.
3. Run `npm test` in `backend/` and make sure all tests pass.
4. Open a pull request describing what changed and why.

For larger changes, especially to the dispatch scoring or the order state machine, open an issue first so we can discuss the approach.
