import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, scoreCandidate } from '../src/dispatch/scoring.js';
import { canTransition, nextStates } from '../src/services/orderStateMachine.js';
import { haversineMeters, etaSeconds, stepToward } from '../src/lib/geo.js';

const weights = { distance: 0.4, eta: 0.35, workload: 0.25 };
const ctx = { readyInSec: 600, radiusM: 3000, weights, now: 1_000_000_000 };
const base = { status: 'ONLINE', active: 0, max: 2, vehicle: 'BIKE', lastAssignedAt: 0 };

test('scoring: closer driver wins when everything else is equal', () => {
  const ranked = rankCandidates(
    [
      { ...base, driverId: 1, distanceM: 2500 },
      { ...base, driverId: 2, distanceM: 400 },
    ],
    ctx,
  );
  assert.equal(ranked[0].driverId, 2);
});

test('scoring: drivers at capacity or offline are never candidates', () => {
  const ranked = rankCandidates(
    [
      { ...base, driverId: 1, distanceM: 100, active: 2 },
      { ...base, driverId: 2, distanceM: 100, status: 'OFFLINE' },
      { ...base, driverId: 3, distanceM: 2900 },
    ],
    ctx,
  );
  assert.deepEqual(ranked.map((c) => c.driverId), [3]);
});

test('scoring: an idle driver beats an equally close driver already carrying an order', () => {
  const ranked = rankCandidates(
    [
      { ...base, driverId: 1, distanceM: 800, active: 1 },
      { ...base, driverId: 2, distanceM: 900, active: 0 },
    ],
    ctx,
  );
  assert.equal(ranked[0].driverId, 2);
});

test('scoring: arriving late costs more than arriving equally early', () => {
  // food ready in 10 min; driver A arrives ~5 min early, driver B ~5 min late
  const a = scoreCandidate({ ...base, driverId: 1, distanceM: 1000 }, { ...ctx, readyInSec: etaSeconds(1000) + 300 });
  const b = scoreCandidate({ ...base, driverId: 2, distanceM: 1000 }, { ...ctx, readyInSec: Math.max(0, etaSeconds(1000) - 300) });
  assert.ok(b.breakdown.eta > a.breakdown.eta);
});

test('scoring: fairness bonus favours the driver who waited longer', () => {
  const recent = scoreCandidate({ ...base, driverId: 1, distanceM: 1000, lastAssignedAt: ctx.now - 60_000 }, ctx);
  const waited = scoreCandidate({ ...base, driverId: 2, distanceM: 1000, lastAssignedAt: ctx.now - 40 * 60_000 }, ctx);
  assert.ok(waited.cost < recent.cost);
});

test('state machine: happy path is allowed for the right roles', () => {
  const path = [
    ['PLACED', 'ACCEPTED', 'RESTAURANT'],
    ['ACCEPTED', 'PREPARING', 'RESTAURANT'],
    ['PREPARING', 'READY', 'RESTAURANT'],
    ['READY', 'PICKED_UP', 'DRIVER'],
    ['PICKED_UP', 'DELIVERED', 'DRIVER'],
  ];
  for (const [from, to, role] of path) assert.equal(canTransition(from, to, role).ok, true, `${from}->${to}`);
});

test('state machine: illegal jumps and wrong roles are rejected', () => {
  assert.equal(canTransition('PLACED', 'DELIVERED', 'ADMIN').reason, 'INVALID_TRANSITION');
  assert.equal(canTransition('READY', 'PICKED_UP', 'RESTAURANT').reason, 'ROLE_NOT_ALLOWED');
  assert.equal(canTransition('ACCEPTED', 'CANCELLED', 'CUSTOMER').reason, 'ROLE_NOT_ALLOWED');
  assert.equal(canTransition('PICKED_UP', 'CANCELLED', 'ADMIN').reason, 'INVALID_TRANSITION');
  assert.deepEqual(nextStates('DELIVERED'), []);
});

test('geo: haversine and stepping', () => {
  const d = haversineMeters(12.9716, 77.5946, 12.9816, 77.5946);
  assert.ok(Math.abs(d - 1112) < 5, `got ${d}`);
  const s = stepToward(12.9716, 77.5946, 12.9816, 77.5946, 500);
  assert.equal(s.arrived, false);
  assert.ok(Math.abs(haversineMeters(12.9716, 77.5946, s.lat, s.lng) - 500) < 2);
});
