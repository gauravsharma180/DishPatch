# DishPatch: resume and interview notes

## Resume entry

**DishPatch** | Node.js, Express.js, PostgreSQL, Redis, Socket.IO, React.js

- Built a real-time food-delivery platform with an 8-state order lifecycle, role-checked transitions, an append-only event trail, and live order tracking over Socket.IO for customers, kitchens, riders and ops.
- Designed a dispatch engine that finds riders with Redis GEOSEARCH in expanding 3/6/10 km rings, ranks them on distance, ETA vs food-ready time and workload, and claims them with guarded SQL updates so concurrent dispatches never exceed rider capacity.
- Implemented idempotent order APIs (Redis + DB unique-key backstop), transactional stock reservation and Redis caching; load-tested 10K orders end to end (79K HTTP requests, 58K websocket events) with zero duplicate orders, zero oversells and zero failed flows.

Shorter variant of bullet 3 if you need the space:
- Added idempotency keys, transactional inventory and Redis caching; a 10K-order load test finished with zero duplicates, oversells or failed flows.

Numbers you can defend (all from `loadtest/RESULTS.md`):
- 10,000 orders, 9,754 delivered, 246 correctly rejected as sold out, 0 failed
- 300-unit flash-sale dish sold exactly 300
- p95 order placement 68 ms, p95 accept-to-rider-assigned 222 ms (20 concurrent flows, 2 vCPU box)
- ~470–500 req/s on that box; CPU-bound, not lock-bound

Don't claim more than this. If asked "would it handle Swiggy's scale", the honest answer is no, and then explain what you'd change (bottom of this page).

## 60-second walkthrough

"DishPatch takes an order from the customer's tap to the doorstep. When a customer orders, one Postgres transaction creates the order and reserves stock with a conditional decrement, so two people can't buy the last plate. The request carries an idempotency key, so a retry from a flaky phone returns the same order instead of making a second one.

When the kitchen accepts, the order goes into a Redis sorted-set queue. A dispatch worker pulls it, searches nearby riders with Redis GEO, scores them on distance, how well their arrival lines up with the food being ready, and how many orders they're already carrying, then claims the best one with a guarded SQL update. That guard is what stops two parallel dispatches from giving one rider five orders.

Every status change and every rider GPS ping is pushed over Socket.IO, so the customer, the kitchen and the ops dashboard all see the same order move. I load-tested 10,000 full order lifecycles and checked in the database afterwards that nothing was duplicated, oversold or left half-assigned."

## Questions you should expect

**Why is Redis the geo index but Postgres decides the assignment?**
Redis is fast but the mirror can be a few ms stale, and it isn't durable. GPS pings arrive every second per rider, so they go to Redis only. The decision that matters (rider X now holds order Y) must be atomic and durable, so it's a Postgres transaction with `WHERE active_orders < max_orders`. If Redis says a rider is free but they aren't, the claim just fails and we try the next one.

**Why not `SELECT ... FOR UPDATE` on the driver row?**
A conditional `UPDATE ... WHERE active_orders < max_orders RETURNING id` is a check-and-set in one statement: it takes the row lock, checks, and writes. `SELECT FOR UPDATE` then `UPDATE` is two round trips and holds the lock longer. The `CHECK (active_orders <= max_orders)` constraint is the last line of defence.

**How do you stop overselling?**
`UPDATE menu_items SET stock = stock - $q WHERE id = $id AND stock >= $q`. Postgres row locks make that atomic. If it updates zero rows, the item is short and the whole transaction rolls back, including the order row. Items are updated in ascending id order so two orders with overlapping items always lock in the same order and can't deadlock. Plus `CHECK (stock >= 0)`.

**Why not decrement stock in Redis?**
You could (Lua `DECRBY` if >= qty) and it's faster for flash sales, but then Redis and Postgres can disagree after a crash, and you need reconciliation. At this scale Postgres row locks are fast enough and you get atomicity with the order insert for free. For a real flash sale on one hot item I'd consider Redis as a gate in front of Postgres.

**Walk me through idempotency.**
`SET key IN_PROGRESS NX EX 30`. If we get it, run the handler and overwrite with the final response for 24h. If not: still in progress → 409 with Retry-After; done → replay; different body hash → 422. 5xx deletes the key so the client can retry. And there's `UNIQUE(customer_id, idempotency_key)` with `ON CONFLICT DO NOTHING` in case Redis lost the key. The load test fires concurrent duplicates and checks the DB count matches.

**Why store 4xx responses but not 5xx?**
A 409 out-of-stock is a real answer; replaying it is correct. A 500 means we don't know if work happened, so the transaction rolled back and we let them retry.

**What does the scoring function actually optimise?**
Cost = 0.4·distance + 0.35·ETA-fit + 0.25·workload − fairness. ETA-fit compares rider arrival time to `ready_by` (accept time + prep time). Arriving late costs 4× more than arriving early, because late means cold food and an angry customer while early just means the rider waits a few minutes. It's a pure function so it's unit-tested and every decision is logged with its score, which means you could replay `dispatch_log` with different weights offline.

**Why dispatch at ACCEPTED instead of READY?**
The rider travels while the food cooks. Dispatching at READY adds the whole travel time to delivery.

**How does the queue work and why not Kafka?**
Sorted set, score = due timestamp. Retries are just a later score. Workers pop due items with a Lua script that does `ZRANGEBYSCORE` + `ZREM` atomically, so N workers never take the same order. It's simple and good enough here. Weakness: enqueue happens after the DB commit, so a crash in between loses the enqueue. The fix is a transactional outbox (write the dispatch request to a table in the same transaction, a relay publishes it), or a sweeper that finds ACCEPTED orders with no driver and no queue entry.

**How does real-time work with multiple servers?**
Socket.IO Redis adapter: an emit on server A is published through Redis and delivered by whichever server holds the socket. The dispatch worker isn't a socket server at all; it uses the Redis emitter to publish the same way. Clients use websocket transport only, so no sticky sessions needed.

**GPS pings every second from thousands of riders. Doesn't that hammer Postgres?**
Pings only touch Redis (`GEOADD`). They're buffered in a hash and flushed every 10s with one `UPDATE ... FROM unnest(...)`, so 1,000 riders cost one statement per 10s instead of 1,000 writes per second. Server also throttles to 1 ping/s per socket.

**What if Redis goes down?**
Placing orders still works (idempotency falls back to the DB constraint) but the middleware errors on the Redis call, so in practice you'd return 503 for a few seconds. Dispatch stops. When Redis is back, restarting the API rebuilds the geo index and driver mirror from Postgres. Nothing in Redis is the only copy of anything important.

**Cache invalidation?**
Menu cache is invalidated on any menu edit, when an item hits zero stock, and on restock. Stale `in_stock: true` can't cause an oversell because the real check is in the transaction; worst case the customer sees a "sold out" error at checkout. Single-flight prevents a stampede when a hot key expires; TTL jitter prevents mass expiry.

**What did the load test actually find?**
First run showed dispatch latency ~1.7s at p50. Two causes: dispatch did several sequential round trips per order, and the client polled every 50 ms, which was most of the server load. I merged the eligibility check and attempt counter into one `UPDATE ... RETURNING`, replaced a full driver re-read with `HINCRBY` on the mirror, ran the log insert in parallel, and switched the client to websocket pushes. p50 dropped to ~555 ms at 100 concurrent flows and ~131 ms at 20. After that, the profile showed the box was simply out of CPU.

**Why did cluster mode not help?**
2 vCPUs shared by Node, Postgres, Redis and the load generator. Node was already using one core; Postgres and the generator used the other. On a bigger box, or with the generator on another machine, cluster mode would scale the API tier.

## Trade-offs to bring up yourself (it shows judgement)

- Greedy one-at-a-time dispatch vs batch matching. Greedy is simple and fast; batching every ~2s and solving assignment (Hungarian / min-cost flow) gives better global results at peak.
- Straight-line ETA vs a routing engine. Fine for a demo, wrong in Bengaluru traffic.
- Auto-accept assignment vs offer-with-timeout. Real apps offer the job and wait ~20s.
- Redis ZSET queue vs a log (Kafka). ZSET is enough for one city; Kafka gives replay, partitioning by city, consumer groups.

## If they ask "how would you scale this to a real city?"

1. Partition by city/zone: separate geo sets and dispatch workers per zone.
2. Outbox pattern for every "DB change → event" so nothing is lost between commit and publish.
3. Batch dispatch with a matching solver, plus a routing engine for ETAs.
4. Read replicas for order history and dashboards; keep writes on the primary.
5. Move GPS ingestion to its own service (it's the highest-volume traffic by far).
6. Proper observability: the `/metrics` endpoint already exposes latency histograms, dispatch outcomes and cache hit rates for Prometheus.
