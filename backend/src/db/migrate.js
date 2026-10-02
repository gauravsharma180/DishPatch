import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

export async function migrate({ reset = false } = {}) {
  if (reset) {
    await pool.query(`
      DROP TABLE IF EXISTS dispatch_log, order_events, order_items, orders, drivers,
        menu_items, restaurants, users CASCADE;
      DROP TYPE IF EXISTS user_role, order_status, dispatch_state, driver_status CASCADE;`);
  }
  const sql = await readFile(path.join(dir, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reset = process.argv.includes('--reset');
  migrate({ reset })
    .then(() => console.log(`migrated${reset ? ' (reset)' : ''}`))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
