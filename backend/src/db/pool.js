import pg from 'pg';
import { config } from '../config.js';

// Return BIGINT/COUNT as JS numbers (ids here stay well under 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30000,
});

export const query = (text, params) => pool.query(text, params);

/**
 * Run fn inside a transaction. Rolls back on any thrown error.
 * Retries on serialization failures / deadlocks, which are expected
 * under heavy concurrent writes and are safe to retry.
 */
export async function withTx(fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const retryable = err.code === '40001' || err.code === '40P01';
      if (retryable && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
