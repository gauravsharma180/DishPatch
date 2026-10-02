import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import {
  placeOrder, transitionOrder, getOrderDetail, listOrders, rejectAssignment,
} from '../services/orderService.js';

const r = Router();
r.use(authenticate);

const placeSchema = z.object({
  restaurantId: z.number().int().positive(),
  items: z.array(z.object({ menuItemId: z.number().int().positive(), qty: z.number().int().min(1).max(20) })).min(1).max(30),
  deliveryLat: z.number().min(-90).max(90),
  deliveryLng: z.number().min(-180).max(180),
  address: z.string().max(300).optional(),
});

r.post(
  '/',
  requireRole('CUSTOMER'),
  validate(placeSchema),
  idempotent('orders:create'),
  ah(async (req, res) => {
    const { order, duplicate } = await placeOrder(req.user, req.body, req.idempotencyKey);
    res.status(duplicate ? 200 : 201).json(order);
  }),
);

r.get(
  '/',
  validate(z.object({ status: z.string().optional(), limit: z.coerce.number().optional() }), 'query'),
  ah(async (req, res) => res.json(await listOrders(req.user, req.query))),
);

r.get('/:id', ah(async (req, res) => res.json(await getOrderDetail(req.params.id, req.user))));

r.post(
  '/:id/transition',
  validate(
    z.object({
      to: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED', 'REJECTED', 'CANCELLED']),
      note: z.string().max(200).optional(),
    }),
  ),
  ah(async (req, res) => res.json(await transitionOrder(req.params.id, req.body.to, req.user, req.body.note))),
);

r.post(
  '/:id/reject-assignment',
  requireRole('DRIVER'),
  ah(async (req, res) => res.json(await rejectAssignment(req.params.id, req.user))),
);

export default r;
