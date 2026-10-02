# Load test results

Raw output: [`results/run-10k-c100.json`](results/run-10k-c100.json) and [`results/run-2k-c20.json`](results/run-2k-c20.json).

## What the test does

Each virtual flow is one complete order, driven through the real HTTP API and real websockets:

1. Customer places the order with a fresh `Idempotency-Key`
2. Customer's tracking socket joins the order room
3. Kitchen: `ACCEPTED` → `PREPARING` → `READY`
4. Wait for the dispatcher's `order:updated` push with a rider assigned (fallback poll only if no push in 5s)
5. That rider: `PICKED_UP` → `DELIVERED`, then posts a GPS ping at the drop point

Two stressors run inside the same test:

- **Retry storm:** 3% of orders fire the same POST twice at once, then a third time after, all with one key.
- **Flash sale:** 5% of orders all want one dish that has only 300 units.

After the run, the script checks invariants **directly in Postgres**, not from the client's point of view.

## Environment

One 2 vCPU / 8 GB cloud VM (Xeon @ 2.1 GHz) running *everything*: the API (single Node process with the embedded dispatch worker), PostgreSQL 16 (default config, `synchronous_commit=on`), Redis 7, and the load generator itself. Seed: 100 restaurants, 1,000 riders, 2,000 customers (300 active), Bengaluru.

So these are honest numbers for a laptop-class box, not a tuned cluster. The CPU is the ceiling: throughput was flat (~470–500 req/s) at both 20 and 100 concurrent flows, and running the API in 2-process cluster mode didn't help because Postgres, Redis and the load generator were already sharing the same two cores.

## Run 1: 10,000 orders, 100 concurrent flows

| | |
|---|---|
| Orders attempted | 10,000 |
| Delivered end to end | **9,754** |
| Correctly rejected (dish sold out) | 246 |
| Failed flows | **0** |
| HTTP requests | 78,855 in 168 s (469 req/s) |
| Websocket events delivered to clients | 58,524 |
| Assignments received via push | 9,753 of 9,754 (5 fallback polls total) |

Latency (ms, client-observed, includes queueing at 100 concurrent flows):

| Endpoint | p50 | p95 | p99 |
|---|---|---|---|
| place order | 254 | 340 | 409 |
| idempotent replay | 28 | 53 | 65 |
| kitchen accept | 195 | 281 | 339 |
| other transitions | 229 | 359 | 428 |
| GPS ping | 33 | 59 | 73 |
| accept → rider assigned (server side) | 555 | 987 | 1,303 |

`place_order` returned 532 × 409: 246 `OUT_OF_STOCK` plus 286 `REQUEST_IN_PROGRESS` from the deliberate concurrent duplicates. Every duplicate's follow-up retry got the original order back (286 replays, 0 mismatches).

### Invariants (checked in Postgres after the run)

| Check | Result |
|---|---|
| Orders in DB = unique 201 responses | ✅ 9,754 = 9,754 |
| Stock conserved for all 800 dishes (before − after = sold) | ✅ 0 mismatches |
| Flash-sale dish never oversold | ✅ exactly 300 sold (289 flash-sale orders + 11 regular orders that included it), 238 turned away |
| No rider over capacity at any point | ✅ enforced by `CHECK` + guarded update |
| All rider slots released after delivery | ✅ 0 still held |
| Every delivered order has the full 6-event trail | ✅ 0 incomplete |
| Idempotent retries returned the same order | ✅ 0 mismatches |

## Run 2: 2,000 orders, 20 concurrent flows (latency when not saturated)

| Endpoint | p50 | p95 | p99 |
|---|---|---|---|
| place order | 43 | 68 | 85 |
| transition | 36 | 59 | 77 |
| GPS ping | 11 | 26 | 34 |
| accept → rider assigned (server side) | 131 | 222 | 272 |
| dispatch decision (search + score + claim) p95 | | 84 | |

2,000 / 2,000 delivered, all invariants pass, 500 req/s.

## Reading the two runs together

Same throughput, 5× the concurrency, ~5× the latency: that's Little's law on a CPU-bound box. The extra concurrency just queues. Correctness didn't change under pressure, which is the point of the test.

## Reproduce

```bash
cd loadtest && npm install
npm run seed
node loadtest.js --orders 10000 --concurrency 100     # writes results/latest.json
node loadtest.js --orders 2000 --concurrency 20
```

Options: `--dup-rate 0.03`, `--hot-rate 0.05`, `--hot-stock 300`, `--customers 300`, `API_URL=http://...`.
