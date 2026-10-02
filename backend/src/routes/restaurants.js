import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { ah, notFound, forbidden } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { getMenu, getNearbyRestaurants, invalidateMenu } from '../services/cacheService.js';
import { emitTo, rooms } from '../realtime/emitter.js';

const r = Router();

r.get(
  '/',
  validate(
    z.object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
      radiusKm: z.coerce.number().min(0.5).max(20).default(7),
    }),
    'query',
  ),
  ah(async (req, res) => {
    const { lat, lng, radiusKm } = req.query;
    res.json(await getNearbyRestaurants(lat, lng, radiusKm));
  }),
);

r.get(
  '/:id/menu',
  ah(async (req, res) => {
    const menu = await getMenu(Number(req.params.id));
    if (!menu) throw notFound('Restaurant not found');
    res.json(menu);
  }),
);

const ownsRestaurant = (req, _res, next) =>
  req.user.role === 'ADMIN' || req.user.restaurantId === Number(req.params.id) ? next() : next(forbidden('Not your restaurant'));

// Kitchen view: full stock numbers (not cached; owners need the truth).
r.get(
  '/:id/inventory',
  authenticate,
  requireRole('RESTAURANT', 'ADMIN'),
  ownsRestaurant,
  ah(async (req, res) => {
    const { rows } = await query(
      'SELECT id, name, price_paise, stock, is_available FROM menu_items WHERE restaurant_id=$1 ORDER BY id',
      [req.params.id],
    );
    res.json(rows);
  }),
);

r.patch(
  '/:id',
  authenticate,
  requireRole('RESTAURANT', 'ADMIN'),
  ownsRestaurant,
  validate(z.object({ isOpen: z.boolean().optional(), avgPrepMinutes: z.number().int().min(1).max(120).optional() })),
  ah(async (req, res) => {
    const { rows: [rest] } = await query(
      `UPDATE restaurants SET is_open=COALESCE($2,is_open), avg_prep_minutes=COALESCE($3,avg_prep_minutes)
        WHERE id=$1 RETURNING *`,
      [req.params.id, req.body.isOpen ?? null, req.body.avgPrepMinutes ?? null],
    );
    if (!rest) throw notFound();
    await invalidateMenu(rest.id);
    res.json(rest);
  }),
);

r.patch(
  '/:id/menu/:itemId',
  authenticate,
  requireRole('RESTAURANT', 'ADMIN'),
  ownsRestaurant,
  validate(
    z.object({
      stock: z.number().int().min(0).optional(),
      pricePaise: z.number().int().positive().optional(),
      isAvailable: z.boolean().optional(),
    }),
  ),
  ah(async (req, res) => {
    const { rows: [item] } = await query(
      `UPDATE menu_items SET stock=COALESCE($3,stock), price_paise=COALESCE($4,price_paise),
              is_available=COALESCE($5,is_available), updated_at=now()
        WHERE id=$2 AND restaurant_id=$1 RETURNING *`,
      [req.params.id, req.params.itemId, req.body.stock ?? null, req.body.pricePaise ?? null, req.body.isAvailable ?? null],
    );
    if (!item) throw notFound('Menu item not found');
    await invalidateMenu(Number(req.params.id)); // write-through invalidation
    emitTo(rooms.restaurant(req.params.id), 'menu:updated', item);
    res.json(item);
  }),
);

export default r;
