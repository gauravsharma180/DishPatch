import { badRequest } from '../lib/errors.js';

/** validate(schema, 'body' | 'query' | 'params') -> replaces req[part] with the parsed value. */
export const validate =
  (schema, part = 'body') =>
  (req, _res, next) => {
    const r = schema.safeParse(req[part]);
    if (!r.success) {
      return next(badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), msg: i.message }))));
    }
    if (part === 'query') Object.defineProperty(req, 'query', { value: r.data, writable: true });
    else req[part] = r.data;
    next();
  };
