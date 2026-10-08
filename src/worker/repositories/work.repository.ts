import type { Pool, PoolClient } from 'pg';
import type { EnrichedProduct } from '../../shared/contracts/platform.js';
import type { ProductJob } from '../../shared/contracts/queues.js';

export interface PendingWork extends ProductJob { id: string; attempts: number }
export interface ItemContext extends ProductJob {
  sku: string; state: string; attempts: number; cid: string; token: string;
  next_attempt_at: Date; processing_started_at: Date | null;
}

export class WorkRepository {
  constructor(public readonly pool: Pool, private readonly source: 'local' | 'remote' = 'remote') {}

  async candidates(staleMs: number, recheckMs: number): Promise<PendingWork[]> {
    const result = await this.pool.query<PendingWork>(`
      WITH chosen AS (
        SELECT o.id, i.attempts FROM outbox o
        JOIN items i ON (i.run_id, i.seq) = (o.run_id, o.seq)
        JOIN runs r ON r.run_id = o.run_id
        WHERE r.cid IS NOT NULL AND r.expected_total IS NOT NULL AND r.source = $3
          AND i.state IN ('pending', 'processing') AND i.next_attempt_at <= now()
          AND (i.state = 'pending' OR i.processing_started_at < now() - ($1 * interval '1 millisecond'))
          AND (o.last_checked_at IS NULL OR o.last_checked_at < now() - ($2 * interval '1 millisecond'))
        ORDER BY o.last_checked_at NULLS FIRST, o.id LIMIT 100
        FOR UPDATE OF o SKIP LOCKED
      )
      UPDATE outbox o SET last_checked_at = now() FROM chosen c WHERE o.id = c.id
      RETURNING o.id::text, o.run_id, o.seq, c.attempts
    `, [staleMs, recheckMs, this.source]);
    return result.rows;
  }

  async published(id: string) {
    await this.pool.query('UPDATE outbox SET published_at = COALESCE(published_at, now()) WHERE id = $1', [id]);
  }

  async lock<T>(message: ProductJob, operation: (client: PoolClient) => Promise<T>): Promise<T | undefined> {
    const client = await this.pool.connect();
    let locked = false;
    let destroy = false;
    try {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1), $2) AS locked', [message.run_id, message.seq]);
      locked = result.rows[0]?.locked === true;
      if (!locked) return undefined;
      return await operation(client);
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtext($1), $2)', [message.run_id, message.seq]); }
        catch { destroy = true; }
      }
      client.release(destroy);
    }
  }

  async context(client: PoolClient, message: ProductJob): Promise<ItemContext | undefined> {
    const result = await client.query<ItemContext>(`
      SELECT i.run_id, i.seq, i.sku, i.state, i.attempts, i.next_attempt_at,
        i.processing_started_at, r.cid, g.token
      FROM items i JOIN runs r ON r.run_id = i.run_id JOIN integrations g ON g.cid = r.cid
      WHERE i.run_id = $1 AND i.seq = $2 AND r.expected_total IS NOT NULL AND r.source = $3
    `, [message.run_id, message.seq, this.source]);
    return result.rows[0];
  }

  async begin(client: PoolClient, message: ProductJob): Promise<number> {
    const result = await client.query<{ attempts: number }>(`
      WITH begun AS (UPDATE items SET state = 'processing', attempts = attempts + 1, processing_started_at = now()
      WHERE run_id = $1 AND seq = $2 RETURNING run_id,seq,attempts)
      INSERT INTO product_attempts (run_id,seq,attempt) SELECT run_id,seq,attempts FROM begun RETURNING attempt AS attempts
    `, [message.run_id, message.seq]);
    if (!result.rows[0]) throw new Error('Item não encontrado.');
    return result.rows[0].attempts;
  }

  async finishAttempt(client: PoolClient, message: ProductJob, attempt: number, durationMs: number, status?: number) {
    await client.query(`UPDATE product_attempts SET finished_at=now(),duration_ms=$4,http_status=$5
      WHERE run_id=$1 AND seq=$2 AND attempt=$3`, [message.run_id, message.seq, attempt, durationMs, status ?? null]);
  }

  async complete(client: PoolClient, message: ProductJob, result: EnrichedProduct) {
    await client.query(`WITH saved AS (
      UPDATE items SET state = 'completed', price = $3, stock = $4,
        processed_at = now(), last_error = NULL WHERE run_id = $1 AND seq = $2
        RETURNING run_id, seq
      ) UPDATE outbox o SET published_at = COALESCE(o.published_at, now())
        FROM saved s WHERE o.run_id = s.run_id AND o.seq = s.seq`,
    [message.run_id, message.seq, result.price, result.stock]);
  }

  async failed(client: PoolClient, message: ProductJob, terminal: boolean, nextAttempt: Date, error: string) {
    await client.query(`UPDATE items SET state = $3, next_attempt_at = $4, last_error = $5,
      processing_started_at = NULL WHERE run_id = $1 AND seq = $2`,
    [message.run_id, message.seq, terminal ? 'failed' : 'pending', nextAttempt, error]);
  }
}
