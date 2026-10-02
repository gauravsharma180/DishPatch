import { Router } from 'express';
import { z } from 'zod';
import { ah, forbidden } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { getDriver, setDriverStatus, updateLocation } from '../services/driverService.js';
import { listOrders } from '../services/orderService.js';

const r = Router();
r.use(authenticate, requireRole('DRIVER'));
r.use((req, _res, next) => (req.user.driverId ? next() : next(forbidden('No driver profile'))));

const loc = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };

r.get(
  '/me',
  ah(async (req, res) => {
    const [driver, active] = await Promise.all([
      getDriver(req.user.driverId),
      listOrders(req.user, { status: 'ACCEPTED,PREPARING,READY,PICKED_UP' }),
    ]);
    res.json({ ...driver, activeOrders: active });
  }),
);

r.post(
  '/me/status',
  validate(z.object({ status: z.enum(['ONLINE', 'OFFLINE']), lat: loc.lat.optional(), lng: loc.lng.optional() })),
  ah(async (req, res) => {
    const { status, lat, lng } = req.body;
    res.json(await setDriverStatus(req.user.driverId, status, lat != null && lng != null ? { lat, lng } : null));
  }),
);

r.post(
  '/me/location',
  validate(z.object(loc)),
  ah(async (req, res) => res.json(await updateLocation(req.user.driverId, req.body.lat, req.body.lng))),
);

export default r;
