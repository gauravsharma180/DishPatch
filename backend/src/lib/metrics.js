import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const ordersCreated = new client.Counter({
  name: 'orders_created_total',
  help: 'Orders successfully created',
  registers: [registry],
});

export const ordersRejected = new client.Counter({
  name: 'orders_rejected_total',
  help: 'Order placements rejected',
  labelNames: ['reason'],
  registers: [registry],
});

export const idempotentReplays = new client.Counter({
  name: 'idempotent_replays_total',
  help: 'Requests answered from the idempotency store instead of re-executing',
  registers: [registry],
});

export const cacheEvents = new client.Counter({
  name: 'cache_events_total',
  help: 'Cache hits and misses',
  labelNames: ['cache', 'result'],
  registers: [registry],
});

export const dispatchLatency = new client.Histogram({
  name: 'dispatch_latency_seconds',
  help: 'Time from order entering the dispatch queue to driver assignment',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const dispatchOutcomes = new client.Counter({
  name: 'dispatch_outcomes_total',
  help: 'Dispatch attempt outcomes',
  labelNames: ['outcome'],
  registers: [registry],
});

export const transitions = new client.Counter({
  name: 'order_transitions_total',
  help: 'Order lifecycle transitions',
  labelNames: ['to'],
  registers: [registry],
});
