import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { unauthorized, forbidden } from '../lib/errors.js';

export const signToken = (user) =>
  jwt.sign(
    { sub: user.id, role: user.role, name: user.name, restaurantId: user.restaurantId, driverId: user.driverId },
    config.jwtSecret,
    { expiresIn: '7d' },
  );

export const verifyToken = (token) => jwt.verify(token, config.jwtSecret);

export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized('Missing bearer token'));
  try {
    const p = verifyToken(token);
    req.user = { id: p.sub, role: p.role, name: p.name, restaurantId: p.restaurantId, driverId: p.driverId };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

export const requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user?.role) ? next() : next(forbidden(`Requires role: ${roles.join(' or ')}`));
