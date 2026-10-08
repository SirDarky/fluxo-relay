import { parseArgs } from 'node:util';
import { database } from '../src/shared/infra/database.js';

try {
  const { values } = parseArgs({ options: { 'run-id': { type: 'string' } } });
  const runId = values['run-id'];
  if (!runId) throw new Error('Uso: npm run integration:status -- --run-id "identificacao-do-lote"');
  const result = await database.query(`SELECT r.run_id, r.expected_total, r.delivery_state,
    r.callback_attempts, r.callback_last_error, r.delivered_at,
    count(i.seq)::int AS received, COALESCE(sum(i.deliveries), 0)::int AS deliveries,
    count(i.seq) FILTER (WHERE i.state = 'completed')::int AS completed,
    count(i.seq) FILTER (WHERE i.state = 'failed')::int AS failed,
    count(i.seq) FILTER (WHERE i.state IN ('pending', 'processing'))::int AS pending
    FROM runs r LEFT JOIN items i ON i.run_id = r.run_id WHERE r.run_id = $1 GROUP BY r.run_id`, [runId]);
  if (!result.rows[0]) throw new Error('Lote não encontrado.');
  const failures = await database.query('SELECT seq, sku, attempts, last_error FROM items WHERE run_id = $1 AND state = $2 ORDER BY seq', [runId, 'failed']);
  console.log(JSON.stringify({ ...result.rows[0], failures: failures.rows }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Não foi possível consultar o lote.');
  process.exitCode = 1;
} finally { await database.end(); }
