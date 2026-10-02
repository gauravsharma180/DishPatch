/**
 * Order lifecycle as an explicit state machine.
 *
 *   PLACED ──accept──▶ ACCEPTED ──▶ PREPARING ──▶ READY ──pickup──▶ PICKED_UP ──▶ DELIVERED
 *     │                   │             │
 *     ├─reject─▶ REJECTED  └──cancel─────┴──▶ CANCELLED
 *     └─cancel─▶ CANCELLED
 *
 * Driver assignment is tracked separately (dispatch_state) so the kitchen and the
 * dispatcher can progress in parallel: we start looking for a rider as soon as the
 * restaurant accepts, not when the food is ready.
 */
export const TRANSITIONS = {
  PLACED: { ACCEPTED: ['RESTAURANT', 'ADMIN'], REJECTED: ['RESTAURANT', 'ADMIN'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  ACCEPTED: { PREPARING: ['RESTAURANT', 'ADMIN'], CANCELLED: ['RESTAURANT', 'ADMIN'] },
  PREPARING: { READY: ['RESTAURANT', 'ADMIN'], CANCELLED: ['RESTAURANT', 'ADMIN'] },
  READY: { PICKED_UP: ['DRIVER', 'ADMIN'] },
  PICKED_UP: { DELIVERED: ['DRIVER', 'ADMIN'] },
  DELIVERED: {},
  REJECTED: {},
  CANCELLED: {},
};

export const TERMINAL = new Set(['DELIVERED', 'REJECTED', 'CANCELLED']);
// States in which inventory was reserved but the order will never complete -> restock.
export const RESTOCK_ON = new Set(['REJECTED', 'CANCELLED']);
// States that hold a driver's capacity slot.
export const DRIVER_ACTIVE = new Set(['ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP']);

export function canTransition(from, to, role) {
  const allowed = TRANSITIONS[from]?.[to];
  if (!allowed) return { ok: false, reason: 'INVALID_TRANSITION' };
  if (!allowed.includes(role)) return { ok: false, reason: 'ROLE_NOT_ALLOWED' };
  return { ok: true };
}

export const nextStates = (from) => Object.keys(TRANSITIONS[from] || {});
