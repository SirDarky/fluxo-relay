import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import pg from 'pg';
import { Redis } from 'ioredis';
import { buildApp } from '../src/api/app.js';
import { database } from '../src/shared/infra/database.js';
import { redis } from '../src/shared/infra/redis.js';
import { env } from '../src/shared/config/env.js';
import { migrate } from '../src/shared/infra/migrate.js';
import { IntegrationRepository } from '../src/api/modules/integration/integration.repository.js';
import { BatchRepository } from '../src/api/modules/batches/batch.repository.js';
import { WorkerPlatformClient, retryAfterMs } from '../src/worker/integration/platform-client.js';
import { createWorkerRuntime } from '../src/worker/runtime.js';
import type { CallbackPayload } from '../src/shared/contracts/platform.js';

async function until(check: () => Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error('Estado esperado não foi atingido no teste local.');
}

test('Worker com Redis, PostgreSQL e plataforma HTTP exclusivamente local', async (t) => {
  const schema = `worker_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `worker-test-${randomUUID()}`;
  const pool = new pg.Pool({ connectionString: env.databaseUrl, options: `-c search_path=${schema}`, max: 12 });
  const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const producer = new Redis(env.redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
  const errors: Error[] = [];
  connection.on('error', (error) => errors.push(error));
  producer.on('error', (error) => errors.push(error));
  const api = buildApp({ pool, logger: false });
  const mock = Fastify({ logger: false });
  const runtimes: ReturnType<typeof createWorkerRuntime>[] = [];
  const calls = new Map<string, number>();
  const timestamps = new Map<string, number[]>();
  const callbacks = new Map<string, CallbackPayload[]>();
  const behaviors = new Map<string, '500-once' | '429-once' | 'always-500' | '401' | '404' | 'bad-sku' | 'hold'>();
  const callbackFailures = new Set<string>();
  const fatalCallbacks = new Set<string>();
  const alwaysFailCallbacks = new Set<string>();
  let active = 0;
  let maxActive = 0;
  let releaseHold: (() => void) | undefined;
  let holdStarted = false;

  t.after(async () => {
    releaseHold?.();
    for (const runtime of runtimes) await runtime.close();
    if (runtimes[0]) {
      // Somente filas com prefixo aleatório deste teste são apagadas.
      const { Queue } = await import('bullmq');
      for (const name of ['fluxo-relay-products', 'fluxo-relay-callbacks']) {
        const queue = new Queue(name, { connection: producer, prefix });
        await queue.obliterate({ force: true });
        await queue.close();
      }
    }
    await mock.close();
    await api.close();
    connection.disconnect();
    producer.disconnect();
    try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally {
      await database.end();
      redis.disconnect();
    }
  });

  await database.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  await api.ready();
  const integrations = new IntegrationRepository(pool);
  const batches = new BatchRepository(pool);
  await integrations.save({ cid: 'local-cid', token: 'local-token', name: 'Simulação', webhook: 'https://simulado.invalid' });

  mock.get<{ Params: { sku: string } }>('/enrich/:sku', async (request, reply) => {
    assert.equal(request.headers['x-cid'], 'local-cid');
    assert.equal(request.headers['x-token'], 'local-token');
    const sku = request.params.sku;
    const count = (calls.get(sku) ?? 0) + 1;
    calls.set(sku, count);
    timestamps.set(sku, [...(timestamps.get(sku) ?? []), Date.now()]);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const behavior = behaviors.get(sku);
      if (behavior === 'hold') {
        holdStarted = true;
        await new Promise<void>((resolve) => { releaseHold = resolve; });
      }
      await delay(20);
      if (behavior === 'always-500' || (behavior === '500-once' && count === 1)) return reply.code(500).send({ error: 'transient' });
      if (behavior === '429-once' && count === 1) return reply.header('retry-after', '1').code(429).send({ error: 'busy' });
      if (behavior === '401' || behavior === '404') return reply.code(Number(behavior)).send({ error: 'permanent' });
      const seq = Number(sku.match(/-(\d+)$/)?.[1] ?? 0);
      return { sku: behavior === 'bad-sku' ? 'wrong-product' : sku, price: seq + 10.25, stock: seq + 100 };
    } finally { active -= 1; }
  });
  mock.post<{ Body: CallbackPayload }>('/callback', async (request, reply) => {
    assert.equal(request.headers['x-token'], 'local-token');
    assert.equal(request.body.cid, 'local-cid');
    const existing = callbacks.get(request.body.run_id) ?? [];
    callbacks.set(request.body.run_id, [...existing, request.body]);
    if (request.body.run_id === 'callback-uncertain' && existing.length === 0) {
      // O simulador recebeu o resultado, mas a confirmação se perde na conexão.
      reply.hijack();
      reply.raw.destroy();
      return reply;
    }
    if (fatalCallbacks.has(request.body.run_id)) return reply.code(401).send({ error: 'invalid-credential' });
    if (alwaysFailCallbacks.has(request.body.run_id)) return reply.code(500).send({ error: 'always-unavailable' });
    if (callbackFailures.has(request.body.run_id) && existing.length === 0) return reply.code(500).send({ error: 'callback-transient' });
    if (request.body.run_id === 'text-report') return reply.type('text/plain').send('Relatório local em texto');
    return { source: 'local-simulator', run_id: request.body.run_id, received: request.body.result.length, divergences: 0 };
  });
  const address = await mock.listen({ host: '127.0.0.1', port: 0 });
  assert.equal(new URL(address).hostname, '127.0.0.1');
  const platform = new WorkerPlatformClient(address, 3000);
  const makeRuntime = () => {
    const runtime = createWorkerRuntime({
      pool, connection, producerConnection: producer, platform, queuePrefix: prefix,
      pollMs: 20, staleMs: 1000, recheckMs: 40,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 10 }, onError: (error) => errors.push(error),
    });
    runtimes.push(runtime);
    return runtime;
  };
  const first = makeRuntime();
  await first.start();
  const second = makeRuntime();
  await second.start();

  const post = async (runId: string, seq: number, sku = `sku-${runId}-${seq}`) => {
    const response = await api.inject({ method: 'POST', url: '/process', payload: { run_id: runId, seq, sku } });
    assert.equal(response.statusCode, 202);
  };
  const seed = (runId: string, total: number) => batches.save('local-cid', { run_id: runId, total, started_at: new Date().toISOString() });
  const delivered = async (runId: string) => {
    const result = await pool.query('SELECT delivery_state FROM runs WHERE run_id = $1', [runId]);
    return result.rows[0]?.delivery_state === 'delivered';
  };

  await t.test('20 itens fora de ordem e duplicados terminam com um callback, limite global 3 em dois workers', async () => {
    await seed('full-run', 20);
    await Promise.all(Array.from({ length: 20 }, (_, index) => post('full-run', 19 - index)));
    await Promise.all(Array.from({ length: 10 }, () => post('full-run', 7)));
    await until(() => delivered('full-run'));
    assert.ok(maxActive <= 3, `Foram observadas ${maxActive} consultas simultâneas.`);
    assert.ok(maxActive > 1);
    assert.equal(callbacks.get('full-run')?.length, 1);
    const payload = callbacks.get('full-run')![0]!;
    assert.equal(payload.result.length, 20);
    assert.deepEqual(payload.result.map((item) => item.seq), Array.from({ length: 20 }, (_, seq) => seq));
    for (const item of payload.result) {
      assert.equal(item.price, item.seq + 10.25);
      assert.equal(item.stock, item.seq + 100);
      assert.equal(calls.get(item.sku), 1);
    }
    const report = await pool.query('SELECT response, result, http_status FROM callback_attempts WHERE run_id = $1', ['full-run']);
    assert.equal(report.rows[0].response.source, 'local-simulator');
    assert.equal(report.rows[0].http_status, 200);
    assert.equal(report.rows[0].result.length, 20);
  });

  await t.test('mensagem anterior aos metadados aguarda sem fazer chamada externa', async () => {
    await post('early-meta', 0);
    await delay(100);
    assert.equal(calls.get('sku-early-meta-0'), undefined);
    await seed('early-meta', 1);
    await until(() => delivered('early-meta'));
    assert.equal(calls.get('sku-early-meta-0'), 1);
  });

  await t.test('comandos de status e exportação leem somente dados locais e preservam a resposta do simulador', async () => {
    const execute = promisify(execFile);
    const options = { env: { ...process.env, PGOPTIONS: `-c search_path=${schema}` }, timeout: 10000, windowsHide: true };
    const status = await execute(process.execPath, ['--import', 'tsx', '--env-file=.env', 'scripts/status.ts', '--run-id', 'full-run'], options);
    const summary = JSON.parse(status.stdout);
    assert.equal(summary.completed, 20);
    assert.equal(summary.deliveries, 30);
    assert.equal(summary.delivery_state, 'delivered');
    assert.equal(summary.failed, 0);
    const output = resolve('output/test-results/local-simulation.json');
    await execute(process.execPath, ['--import', 'tsx', '--env-file=.env', 'scripts/report.ts', '--run-id', 'full-run', '--output', output], options);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.response.source, 'local-simulator');
    assert.equal(report.result.length, 20);
    assert.equal(report.http_status, 200);
  });

  await t.test('falha 500 é repetida e 429 respeita retry-after sem segurar a vaga', async () => {
    behaviors.set('sku-retries-0', '500-once');
    behaviors.set('sku-retries-1', '429-once');
    await seed('retries', 2);
    await post('retries', 0);
    await post('retries', 1);
    await until(() => delivered('retries'));
    assert.equal(calls.get('sku-retries-0'), 2);
    assert.equal(calls.get('sku-retries-1'), 2);
    const times = timestamps.get('sku-retries-1')!;
    assert.ok(times[1]! - times[0]! >= 1000);
  });

  await t.test('401, 404 e SKU divergente falham sem repetir nem enviar lote incompleto', async () => {
    behaviors.set('sku-fatal-0', '401');
    behaviors.set('sku-fatal-1', '404');
    behaviors.set('sku-fatal-2', 'bad-sku');
    await seed('fatal', 3);
    for (let seq = 0; seq < 3; seq += 1) await post('fatal', seq);
    await until(async () => (await pool.query("SELECT count(*)::int AS count FROM items WHERE run_id = 'fatal' AND state = 'failed'")).rows[0].count === 3);
    for (let seq = 0; seq < 3; seq += 1) assert.equal(calls.get(`sku-fatal-${seq}`), 1);
    assert.equal(callbacks.get('fatal'), undefined);
  });

  await t.test('falhas temporárias persistentes respeitam limite durável de tentativas', async () => {
    behaviors.set('sku-exhausted-0', 'always-500');
    await seed('exhausted', 1);
    await post('exhausted', 0);
    await until(async () => (await pool.query("SELECT state FROM items WHERE run_id = 'exhausted'")).rows[0]?.state === 'failed');
    assert.equal(calls.get('sku-exhausted-0'), 3);
    await delay(100);
    assert.equal(calls.get('sku-exhausted-0'), 3);
    assert.equal(callbacks.get('exhausted'), undefined);
  });

  await t.test('duplicata pode receber ACK enquanto o worker consulta o mesmo produto', async () => {
    behaviors.set('sku-held-0', 'hold');
    await seed('held', 1);
    await post('held', 0);
    await until(async () => holdStarted);
    try { await post('held', 0); } finally { releaseHold?.(); }
    await until(() => delivered('held'));
    assert.equal(calls.get('sku-held-0'), 1);
    const item = await pool.query("SELECT deliveries FROM items WHERE run_id = 'held'");
    assert.equal(item.rows[0].deliveries, 2);
  });

  await t.test('reentrega de trabalho já concluído não consulta o SKU novamente', async () => {
    await first.products.add('enrich', { run_id: 'full-run', seq: 7 }, { jobId: `duplicate-${randomUUID()}` });
    await delay(150);
    assert.equal(calls.get('sku-full-run-7'), 1);
    assert.equal(callbacks.get('full-run')?.length, 1);
  });

  await t.test('callback temporariamente indisponível é reenviado sem consultar os produtos novamente', async () => {
    callbackFailures.add('callback-retry');
    await seed('callback-retry', 1);
    await post('callback-retry', 0);
    await until(() => delivered('callback-retry'));
    assert.equal(calls.get('sku-callback-retry-0'), 1);
    assert.equal(callbacks.get('callback-retry')?.length, 2);
    const attempts = await pool.query('SELECT attempt, error, http_status FROM callback_attempts WHERE run_id = $1 ORDER BY attempt', ['callback-retry']);
    assert.equal(attempts.rows.length, 2);
    assert.ok(attempts.rows[0].error);
    assert.equal(attempts.rows[0].http_status, 500);
    assert.equal(attempts.rows[1].http_status, 200);
  });

  await t.test('resposta do callback em texto também é guardada', async () => {
    await seed('text-report', 1);
    await post('text-report', 0);
    await until(() => delivered('text-report'));
    const result = await pool.query("SELECT response FROM callback_attempts WHERE run_id = 'text-report'");
    assert.equal(result.rows[0].response, 'Relatório local em texto');
  });

  await t.test('callback recebido com confirmação perdida pode ser reenviado, com histórico preservado', async () => {
    await seed('callback-uncertain', 1);
    await post('callback-uncertain', 0);
    await until(() => delivered('callback-uncertain'));
    assert.equal(calls.get('sku-callback-uncertain-0'), 1);
    assert.equal(callbacks.get('callback-uncertain')?.length, 2);
    const result = await pool.query('SELECT error, http_status FROM callback_attempts WHERE run_id = $1 ORDER BY attempt', ['callback-uncertain']);
    assert.equal(result.rows.length, 2);
    assert.ok(result.rows[0].error);
    assert.equal(result.rows[1].http_status, 200);
  });

  await t.test('callback 401 para imediatamente; falhas temporárias encerram após o limite', async () => {
    fatalCallbacks.add('callback-fatal');
    alwaysFailCallbacks.add('callback-exhausted');
    for (const runId of ['callback-fatal', 'callback-exhausted']) {
      await seed(runId, 1);
      await post(runId, 0);
      await until(async () => (await pool.query('SELECT delivery_state FROM runs WHERE run_id = $1', [runId])).rows[0]?.delivery_state === 'failed');
      assert.equal(calls.get(`sku-${runId}-0`), 1);
    }
    assert.equal(callbacks.get('callback-fatal')?.length, 1);
    assert.equal(callbacks.get('callback-exhausted')?.length, 3);
  });

  await t.test('mesmo SKU em posições diferentes é preservado como dois itens', async () => {
    await seed('same-sku', 2);
    await post('same-sku', 0, 'shared-sku-0');
    await post('same-sku', 1, 'shared-sku-0');
    await until(() => delivered('same-sku'));
    assert.equal(calls.get('shared-sku-0'), 2);
    assert.deepEqual(callbacks.get('same-sku')![0]!.result.map((item) => item.seq), [0, 1]);
  });

  await t.test('limite global é restaurado antes de publicar após perda da configuração Redis', async () => {
    await first.products.removeGlobalConcurrency();
    await first.callbacks.removeGlobalConcurrency();
    await first.publisher.publish();
    assert.equal(await first.products.getGlobalConcurrency(), 3);
    assert.equal(await first.callbacks.getGlobalConcurrency(), 1);
  });

  await t.test('trabalho publicado e interrompido é reconstruído do banco sem resetar tentativas', async () => {
    await first.close();
    await second.close();
    await seed('recovered', 1);
    await post('recovered', 0);
    await pool.query(`UPDATE items SET state = 'processing', attempts = 1,
      processing_started_at = now() - interval '30 seconds' WHERE run_id = 'recovered'`);
    await pool.query("UPDATE outbox SET published_at = now() WHERE run_id = 'recovered'");
    // A fila não tem esse trabalho, simulando perda do Redis após publicação.
    const recovered = makeRuntime();
    await recovered.start();
    await until(() => delivered('recovered'));
    assert.equal(calls.get('sku-recovered-0'), 1);
    const item = await pool.query("SELECT attempts, state FROM items WHERE run_id = 'recovered'");
    assert.deepEqual(item.rows[0], { attempts: 2, state: 'completed' });
  });

  await t.test('callback interrompido é retomado com os resultados salvos, sem novo enriquecimento', async () => {
    await runtimes.at(-1)!.close();
    await seed('callback-crash', 1);
    await post('callback-crash', 0);
    await pool.query(`UPDATE items SET state = 'completed', price = 10.25, stock = 100,
      processed_at = now() WHERE run_id = 'callback-crash'`);
    await pool.query(`UPDATE runs SET delivery_state = 'sending', callback_attempts = 1,
      callback_started_at = now() - interval '30 seconds' WHERE run_id = 'callback-crash'`);
    await pool.query(`INSERT INTO callback_attempts (id, run_id, attempt, result) VALUES ($1, $2, 1, $3::jsonb)`,
      [randomUUID(), 'callback-crash', JSON.stringify([{ seq: 0, sku: 'sku-callback-crash-0', price: 10.25, stock: 100 }])]);
    const restarted = makeRuntime();
    await restarted.start();
    await until(() => delivered('callback-crash'));
    assert.equal(calls.get('sku-callback-crash-0'), undefined);
    const attempts = await pool.query("SELECT attempt, http_status FROM callback_attempts WHERE run_id = 'callback-crash' ORDER BY attempt");
    assert.deepEqual(attempts.rows, [{ attempt: 1, http_status: null }, { attempt: 2, http_status: 200 }]);
  });

  await t.test('retry-after aceita segundos e data HTTP', () => {
    assert.equal(retryAfterMs('2'), 2000);
    const now = Date.parse('2026-10-06T12:00:00Z');
    assert.equal(retryAfterMs('Tue, 06 Oct 2026 12:00:03 GMT', now), 3000);
    assert.equal(retryAfterMs('invalid'), 0);
    assert.equal(retryAfterMs(null), 0);
  });
  assert.deepEqual(errors.map((error) => error.message), []);
});
