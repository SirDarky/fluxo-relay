import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, type Job } from 'bullmq';
import { database } from '../src/shared/infra/database.js';
import { createRedis, redis } from '../src/shared/infra/redis.js';
import { infrastructureQueueName, type InfrastructureProbe, type InfrastructureResult } from '../src/shared/contracts/queues.js';

const connection = createRedis('worker');
connection.on('error', () => {});
redis.on('error', () => {});
const queue = new Queue<InfrastructureProbe, InfrastructureResult>(infrastructureQueueName, { connection });
const events = new QueueEvents(infrastructureQueueName, { connection });
const runId = `verify-${randomUUID()}`;
let probeJob: Job<InfrastructureProbe, InfrastructureResult> | undefined;
events.on('error', () => {});
const watchdog = setTimeout(() => { console.error('Verificação excedeu 30 segundos.'); process.exit(1); }, 30000);

try {
  const url = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
  const ready = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(5000) });
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready', postgres: 'ok', redis: 'ok' });
  console.log('OK: API conectada ao PostgreSQL e Redis.');

  const check = await fetch(`${url}/check`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'handshake-local-test' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(check.status, 200);
  assert.deepEqual(await check.json(), { token: 'handshake-local-test' });
  const invalid = await fetch(`${url}/check`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(invalid.status, 400);
  console.log('OK: /check devolve o token e rejeita uma mensagem sem token.');

  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE infra_probe (value text) ON COMMIT DROP');
    await client.query('INSERT INTO infra_probe VALUES ($1)', ['persistencia-ok']);
    const result = await client.query('SELECT value FROM infra_probe');
    assert.equal(result.rows[0].value, 'persistencia-ok');
    await client.query('ROLLBACK');
  } finally { client.release(); }
  console.log('OK: PostgreSQL aceita escrita e leitura.');

  const messages = Array.from({ length: 20 }, (_, seq) => ({ run_id: runId, seq, sku: `verify-sku-${seq}` }));
  const deliveries = [...messages.reverse(), ...Array.from({ length: 10 }, () => ({ run_id: runId, seq: 7, sku: 'verify-sku-7' }))];
  const ackTimes = await Promise.all(deliveries.map(async (message) => {
    const started = performance.now();
    const response = await fetch(`${url}/process`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true });
    return performance.now() - started;
  }));
  const items = await database.query(`SELECT count(*)::int AS count, sum(deliveries)::int AS deliveries
    FROM items WHERE run_id = $1`, [runId]);
  assert.deepEqual(items.rows[0], { count: 20, deliveries: 30 });
  const outbox = await database.query('SELECT count(*)::int AS count FROM outbox WHERE run_id = $1', [runId]);
  assert.equal(outbox.rows[0].count, 20);
  console.log(`OK: /process recebeu 20 itens e 10 duplicatas; 20 trabalhos guardados. Maior ACK local: ${Math.max(...ackTimes).toFixed(0)} ms.`);

  await events.waitUntilReady();
  const message = `fila-ok-${randomUUID()}`;
  probeJob = await queue.add('probe', { message });
  assert.deepEqual(await probeJob.waitUntilFinished(events, 10000), { received: message, processedBy: 'worker' });
  console.log('OK: o worker separado processou o trabalho publicado pela verificação.');
} finally {
  const cleanup = await Promise.allSettled([
    ...(probeJob ? [probeJob.remove()] : []),
    database.query('DELETE FROM runs WHERE run_id = $1', [runId]),
  ]);
  for (const result of cleanup) {
    if (result.status === 'rejected') {
      console.error('Não foi possível limpar um dado da verificação:', result.reason instanceof Error ? result.reason.message : 'erro');
      process.exitCode = 1;
    }
  }
  const closed = await Promise.allSettled([events.close(), queue.close(), database.end()]);
  for (const result of closed) {
    if (result.status === 'rejected') process.exitCode = 1;
  }
  connection.disconnect();
  redis.disconnect();
  clearTimeout(watchdog);
}
