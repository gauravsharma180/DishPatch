import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { ah, unauthorized, conflict } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { authenticate, signToken } from '../middleware/auth.js';

const r = Router();

async function loadPrincipal(user) {
  const out = { id: user.id, name: user.name, email: user.email, role: user.role };
  if (user.role === 'RESTAURANT') {
    const { rows: [rest] } = await query('SELECT id FROM restaurants WHERE owner_id=$1 LIMIT 1', [user.id]);
    out.restaurantId = rest?.id;
  }
  if (user.role === 'DRIVER') {
    const { rows: [d] } = await query('SELECT id FROM drivers WHERE user_id=$1', [user.id]);
    out.driverId = d?.id;
  }
  return out;
}

r.post(
  '/login',
  validate(z.object({ email: z.string().email(), password: z.string().min(1) })),
  ah(async (req, res) => {
    const { rows: [user] } = await query('SELECT * FROM users WHERE email=$1', [req.body.email.toLowerCase()]);
    if (!user || !(await bcrypt.compare(req.body.password, user.password_hash))) throw unauthorized('Bad credentials');
    const principal = await loadPrincipal(user);
    res.json({ token: signToken(principal), user: principal });
  }),
);

r.post(
  '/register',
  validate(z.object({ name: z.string().min(1).max(80), email: z.string().email(), password: z.string().min(6) })),
  ah(async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    try {
      const { rows: [user] } = await query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'CUSTOMER') RETURNING *`,
        [req.body.name, req.body.email.toLowerCase(), hash],
      );
      const principal = await loadPrincipal(user);
      res.status(201).json({ token: signToken(principal), user: principal });
    } catch (e) {
      if (e.code === '23505') throw conflict('EMAIL_TAKEN', 'Email already registered');
      throw e;
    }
  }),
);

r.get('/me', authenticate, (req, res) => res.json({ user: req.user }));

export default r;
