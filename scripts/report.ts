import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { database } from '../src/shared/infra/database.js';

try {
  const { values } = parseArgs({ options: {
    'run-id': { type: 'string' }, attempt: { type: 'string' }, output: { type: 'string' },
  } });
  const runId = values['run-id'];
  if (!runId) throw new Error('Uso: npm run integration:report -- --run-id "identificacao-do-lote" [--attempt 1] [--output arquivo.json]');
  const attempt = values.attempt === undefined ? null : Number(values.attempt);
  if (attempt !== null && (!Number.isInteger(attempt) || attempt < 1)) throw new Error('A tentativa precisa ser um inteiro positivo.');
  const result = await database.query(`SELECT run_id, attempt, result, http_status, response, started_at, finished_at
    FROM callback_attempts WHERE run_id = $1 AND ($2::integer IS NULL OR attempt = $2)
    AND http_status BETWEEN 200 AND 299 ORDER BY attempt DESC LIMIT 1`, [runId, attempt]);
  if (!result.rows[0]) throw new Error('Nenhum callback aceito encontrado para este lote/tentativa.');
  const path = resolve(values.output ?? `output/reports/${encodeURIComponent(runId)}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result.rows[0], null, 2) + '\n', 'utf8');
  console.log(`Resposta do callback e resultado exportados para ${path}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Não foi possível exportar a resposta.');
  process.exitCode = 1;
} finally { await database.end(); }
