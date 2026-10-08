import type { Pool } from 'pg';
import type { Burst } from '../../../shared/contracts/platform.js';

export class BatchRepository {
  constructor(private readonly pool: Pool) {}

  async save(cid: string, burst: Burst) {
    const result = await this.pool.query(`
      INSERT INTO runs (run_id, cid, expected_total, started_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT (run_id) DO UPDATE SET
        cid = EXCLUDED.cid, expected_total = EXCLUDED.expected_total, started_at = EXCLUDED.started_at
      WHERE (runs.cid IS NULL OR runs.cid = EXCLUDED.cid)
        AND (runs.expected_total IS NULL OR runs.expected_total = EXCLUDED.expected_total)
      RETURNING run_id
    `, [burst.run_id, cid, burst.total, burst.started_at]);
    if (result.rowCount !== 1) throw new Error('Os dados recebidos conflitam com o lote já registrado.');
  }
}
