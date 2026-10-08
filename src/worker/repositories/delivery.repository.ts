import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CallbackPayload, CallbackResponse } from '../../shared/contracts/platform.js';

interface DeliveryContext {
  run_id: string; cid: string; token: string; expected_total: number;
  callback_attempts: number; callback_next_attempt_at: Date; delivery_state: string;
}

export class DeliveryRepository {
  constructor(private readonly pool: Pool, private readonly source: 'local' | 'remote' = 'remote') {}

  async candidates(staleMs: number): Promise<{ run_id: string; callback_attempts: number }[]> {
    const result = await this.pool.query(`
      SELECT r.run_id, r.callback_attempts FROM runs r
      WHERE r.cid IS NOT NULL AND r.expected_total IS NOT NULL AND r.source = $2
        AND r.delivery_state IN ('waiting', 'sending') AND r.callback_next_attempt_at <= now()
        AND (r.delivery_state = 'waiting' OR r.callback_started_at < now() - ($1 * interval '1 millisecond'))
        AND (SELECT count(*) FROM items i WHERE i.run_id = r.run_id) = r.expected_total
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.run_id = r.run_id AND i.state <> 'completed')
      ORDER BY r.callback_next_attempt_at, r.run_id LIMIT 100
    `, [staleMs, this.source]);
    return result.rows;
  }

  async lock<T>(runId: string, operation: (client: PoolClient) => Promise<T>): Promise<T | undefined> {
    const client = await this.pool.connect();
    let locked = false;
    let destroy = false;
    try {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1), -1) AS locked', [runId]);
      locked = result.rows[0]?.locked === true;
      if (!locked) return undefined;
      return await operation(client);
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtext($1), -1)', [runId]); } catch { destroy = true; }
      }
      client.release(destroy);
    }
  }

  async context(client: PoolClient, runId: string): Promise<DeliveryContext | undefined> {
    const result = await client.query<DeliveryContext>(`
      SELECT r.*, g.token FROM runs r JOIN integrations g ON g.cid = r.cid WHERE r.run_id = $1 AND r.source=$2
    `, [runId, this.source]);
    return result.rows[0];
  }

  async payload(client: PoolClient, context: DeliveryContext): Promise<CallbackPayload | undefined> {
    const result = await client.query<{ seq: number; sku: string; price: string | null; stock: number | null; state: string }>(
      'SELECT seq, sku, price, stock, state FROM items WHERE run_id = $1 ORDER BY seq', [context.run_id],
    );
    if (result.rows.length !== context.expected_total
      || result.rows.some((item) => item.state !== 'completed' || item.price === null || item.stock === null)) return undefined;
    return { cid: context.cid, run_id: context.run_id, result: result.rows.map((item) => ({
      seq: item.seq, sku: item.sku, price: Number(item.price), stock: item.stock!,
    })) };
  }

  async begin(client: PoolClient, payload: CallbackPayload): Promise<{ id: string; attempt: number }> {
    const id = randomUUID();
    await client.query('BEGIN');
    try {
      const run = await client.query<{ callback_attempts: number }>(`UPDATE runs SET delivery_state = 'sending',
        callback_attempts = callback_attempts + 1, callback_started_at = now()
        WHERE run_id = $1 RETURNING callback_attempts`, [payload.run_id]);
      const attempt = run.rows[0]!.callback_attempts;
      await client.query('INSERT INTO callback_attempts (id, run_id, attempt, result) VALUES ($1, $2, $3, $4::jsonb)',
        [id, payload.run_id, attempt, JSON.stringify(payload.result)]);
      await client.query('COMMIT');
      return { id, attempt };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }

  async complete(client: PoolClient, runId: string, id: string, response: CallbackResponse) {
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE callback_attempts SET finished_at = now(), http_status = $2,
        response = $3::jsonb WHERE id = $1`, [id, response.status, JSON.stringify(response.body)]);
      await client.query(`UPDATE runs SET delivery_state = 'delivered', delivered_at = now(),
        callback_last_error = NULL WHERE run_id = $1`, [runId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }

  async failed(client: PoolClient, runId: string, id: string | undefined, terminal: boolean, nextAttempt: Date, error: string, status?: number) {
    await client.query('BEGIN');
    try {
      if (id) await client.query('UPDATE callback_attempts SET finished_at = now(), error = $2, http_status = $3 WHERE id = $1', [id, error, status ?? null]);
      await client.query(`UPDATE runs SET delivery_state = $2, callback_next_attempt_at = $3,
        callback_last_error = $4, callback_started_at = NULL WHERE run_id = $1`,
      [runId, terminal ? 'failed' : 'waiting', nextAttempt, error]);
      await client.query('COMMIT');
    } catch (failure) { await client.query('ROLLBACK'); throw failure; }
  }
}
