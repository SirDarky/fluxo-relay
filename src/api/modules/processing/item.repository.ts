import type { Pool } from 'pg';
import type { ProcessMessage } from '../../../shared/contracts/processing.js';
import { ApiError } from '../../errors.js';

export class ItemRepository {
  constructor(private readonly pool: Pool) {}

  async receive(message: ProcessMessage): Promise<{ duplicate: boolean }> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '400ms'; SET LOCAL lock_timeout = '300ms'");
      await client.query('INSERT INTO runs (run_id) VALUES ($1) ON CONFLICT DO NOTHING', [message.run_id]);
      const inserted = await client.query(`
        INSERT INTO items (run_id, seq, sku) VALUES ($1, $2, $3)
        ON CONFLICT (run_id, seq) DO NOTHING RETURNING seq
      `, [message.run_id, message.seq, message.sku]);

      if (inserted.rowCount === 1) {
        await client.query(`
          INSERT INTO outbox (run_id, seq, event_type, payload)
          VALUES ($1, $2, 'enrich_item', $3::jsonb)
        `, [message.run_id, message.seq, JSON.stringify(message)]);
      } else {
        const duplicate = await client.query(`
          UPDATE items SET deliveries = deliveries + 1, last_received_at = now()
          WHERE run_id = $1 AND seq = $2 AND sku = $3 RETURNING seq
        `, [message.run_id, message.seq, message.sku]);
        if (duplicate.rowCount !== 1) {
          throw new ApiError(409, 'ITEM_CONFLICT', 'Este item do lote já foi recebido com outro SKU.');
        }
      }

      await client.query('COMMIT');
      return { duplicate: inserted.rowCount !== 1 };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { destroy = true; }
      throw error;
    } finally { client.release(destroy); }
  }
}
