import { etaSeconds } from '../lib/geo.js';

/**
 * Pure scoring function: no I/O, so it's trivially unit-testable and tunable offline
 * against dispatch_log.
 *
 * Lower cost = better match. Each component is normalised to roughly [0, 1]:
 *
 *  distance  straight-line metres to the restaurant / search radius.
 *  eta       how badly the driver's arrival misses the food-ready time.
 *            Arriving LATE (food goes cold, customer waits) costs 4x more than
 *            arriving EARLY (driver idles at the counter).
 *  workload  orders already in hand / capacity. A driver carrying an order also gets
 *            a time penalty because they have to finish or detour first.
 *  fairness  small bonus for drivers who haven't had an order recently, so the same
 *            few drivers parked next to popular restaurants don't take everything.
 */
export const PER_ACTIVE_ORDER_PENALTY_SEC = 240;
const EARLY_WEIGHT = 0.25;
const ETA_NORM_SEC = 1800;
const FAIRNESS_MAX = 0.05;
const FAIRNESS_WINDOW_MS = 30 * 60 * 1000;

export function scoreCandidate(c, ctx) {
  const { readyInSec, radiusM, weights, now = Date.now() } = ctx;

  const travelSec = etaSeconds(c.distanceM, c.vehicle);
  const etaSec = travelSec + c.active * PER_ACTIVE_ORDER_PENALTY_SEC;

  const late = Math.max(0, etaSec - readyInSec);
  const early = Math.max(0, readyInSec - etaSec);

  const distance = Math.min(1, c.distanceM / radiusM);
  const eta = Math.min(1, (late + EARLY_WEIGHT * early) / ETA_NORM_SEC);
  const workload = c.max > 0 ? c.active / c.max : 1;
  const idleMs = c.lastAssignedAt ? now - c.lastAssignedAt : FAIRNESS_WINDOW_MS;
  const fairness = FAIRNESS_MAX * Math.min(1, idleMs / FAIRNESS_WINDOW_MS);

  const cost = weights.distance * distance + weights.eta * eta + weights.workload * workload - fairness;

  return {
    ...c,
    etaSec,
    cost: Math.round(cost * 10000) / 10000,
    breakdown: { distance, eta, workload, fairness },
  };
}

export function rankCandidates(candidates, ctx) {
  return candidates
    .filter((c) => c.status === 'ONLINE' && c.active < c.max)
    .map((c) => scoreCandidate(c, ctx))
    .sort((a, b) => a.cost - b.cost || a.distanceM - b.distanceM);
}
