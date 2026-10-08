import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { buildApp } from '../src/api/app.js';
import { database } from '../src/shared/infra/database.js';
import { redis } from '../src/shared/infra/redis.js';
import { env } from '../src/shared/config/env.js';
import { migrate } from '../src/shared/infra/migrate.js';
import { IntegrationRepository } from '../src/api/modules/integration/integration.repository.js';
import { IntegrationService } from '../src/api/modules/integration/integration.service.js';
import { PlatformClient, PlatformError } from '../src/api/modules/integration/platform-client.js';
import { BatchRepository } from '../src/api/modules/batches/batch.repository.js';

test('API com PostgreSQL real e plataforma simulada', async (t) => {
  const schema = `api_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({
    connectionString: env.databaseUrl,
    options: `-c search_path=${schema}`,
    max: 8,
    connectionTimeoutMillis: 2000,
  });
  const app = buildApp({ pool, logger: false });
  t.after(async () => {
    try { await app.close(); } finally {
      try { await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally {
        await database.end();
        redis.disconnect();
      }
    }
  });
  // O nome é gerado internamente; nenhum dado ou schema existente é apagado.
  await database.query(`CREATE SCHEMA "${schema}"`);
  assert.deepEqual(await migrate(pool), ['001_api_receiving.sql', '002_worker_processing.sql', '003_dashboard.sql', '004_test_history.sql']);
  await app.ready();
  const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/process', payload });
  const integrations = new IntegrationRepository(pool);
  const batches = new BatchRepository(pool);

  await t.test('migrations podem ser repetidas sem perder os dados', async () => {
    assert.deepEqual(await migrate(pool), []);
    const result = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
    assert.equal(result.rows[0].count, 4);
  });

  await t.test('/check devolve exatamente o token e exige token válido', async () => {
    const response = await app.inject({ method: 'POST', url: '/check', payload: { token: 'token-check' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { token: 'token-check' });
    for (const payload of [{}, { token: '' }, { token: 12 }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/check', payload })).statusCode, 400);
    }
  });

  await t.test('/process rejeita mensagens inválidas sem gravar trabalhos', async () => {
    const good = { run_id: 'invalid-run', seq: 0, sku: 'arroz' };
    const invalid = [
      {}, { run_id: good.run_id, seq: 0 }, { ...good, seq: -1 },
      { ...good, seq: 1.5 }, { ...good, seq: '0' }, { ...good, sku: '' },
      { ...good, run_id: ' ' }, { ...good, seq: 2147483648 },
    ];
    for (const payload of invalid) assert.equal((await post(payload)).statusCode, 400);
    const result = await pool.query('SELECT count(*)::int AS count FROM runs');
    assert.equal(result.rows[0].count, 0);
  });

  await t.test('ACK 202 só após guardar item e outbox, sem consultar enriquecimento', async () => {
    const message = { run_id: 'received-run', seq: 7, sku: 'arroz' };
    const response = await post(message);
    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), { ok: true });
    const items = await pool.query('SELECT * FROM items WHERE run_id = $1', [message.run_id]);
    assert.equal(items.rows.length, 1);
    assert.equal(items.rows[0].state, 'pending');
    assert.equal(items.rows[0].price, null);
    const jobs = await pool.query('SELECT * FROM outbox WHERE run_id = $1', [message.run_id]);
    assert.equal(jobs.rows.length, 1);
    assert.deepEqual(jobs.rows[0].payload, message);
    assert.equal(jobs.rows[0].published_at, null);
  });

  await t.test('30 duplicatas simultâneas geram um único item e um único trabalho', async () => {
    const message = { run_id: 'received-run', seq: 7, sku: 'arroz' };
    const responses = await Promise.all(Array.from({ length: 30 }, () => post(message)));
    assert.ok(responses.every((response) => response.statusCode === 202));
    const result = await pool.query(`SELECT count(*)::int AS count, max(deliveries) AS deliveries
      FROM items WHERE run_id = $1`, [message.run_id]);
    assert.equal(result.rows[0].count, 1);
    assert.equal(result.rows[0].deliveries, 31);
    const jobs = await pool.query('SELECT count(*)::int AS count FROM outbox WHERE run_id = $1', [message.run_id]);
    assert.equal(jobs.rows[0].count, 1);
  });

  await t.test('SKU repetido em outra posição ou lote continua sendo outro item', async () => {
    assert.equal((await post({ run_id: 'received-run', seq: 8, sku: 'arroz' })).statusCode, 202);
    assert.equal((await post({ run_id: 'other-run', seq: 7, sku: 'arroz' })).statusCode, 202);
    const result = await pool.query('SELECT count(*)::int AS count FROM items WHERE sku = $1', ['arroz']);
    assert.equal(result.rows[0].count, 3);
  });

  await t.test('mesma identidade com outro SKU dá conflito e preserva o original', async () => {
    const response = await post({ run_id: 'received-run', seq: 7, sku: 'outro-produto' });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'ITEM_CONFLICT');
    const result = await pool.query('SELECT sku, deliveries FROM items WHERE run_id = $1 AND seq = 7', ['received-run']);
    assert.equal(result.rows[0].sku, 'arroz');
    assert.equal(result.rows[0].deliveries, 31);
  });

  await t.test('mensagens fora de ordem são aceitas sem concluir o lote por seq', async () => {
    for (const seq of [19, 2, 0]) {
      assert.equal((await post({ run_id: 'unordered-run', seq, sku: `sku-${seq}` })).statusCode, 202);
    }
    const result = await pool.query('SELECT seq FROM items WHERE run_id = $1 ORDER BY seq', ['unordered-run']);
    assert.deepEqual(result.rows.map((row) => row.seq), [0, 2, 19]);
    const run = await pool.query('SELECT expected_total FROM runs WHERE run_id = $1', ['unordered-run']);
    assert.equal(run.rows[0].expected_total, null);
  });

  await t.test('falha ao gravar outbox retorna 503 e desfaz também item e lote', async () => {
    await pool.query(`CREATE FUNCTION fail_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Falha proposital do teste'; END;
    $$`);
    await pool.query(`CREATE TRIGGER fail_outbox_test BEFORE INSERT ON outbox
      FOR EACH ROW WHEN (NEW.run_id = 'rollback-run') EXECUTE FUNCTION fail_outbox_test()`);
    try {
      const response = await post({ run_id: 'rollback-run', seq: 0, sku: 'feijao' });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error, 'RECEIVING_UNAVAILABLE');
      for (const table of ['runs', 'items', 'outbox']) {
        const result = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE run_id = $1`, ['rollback-run']);
        assert.equal(result.rows[0].count, 0);
      }
    } finally {
      await pool.query('DROP TRIGGER fail_outbox_test ON outbox');
      await pool.query('DROP FUNCTION fail_outbox_test()');
    }
    assert.equal((await post({ run_id: 'rollback-run', seq: 0, sku: 'feijao' })).statusCode, 202);
  });

  await t.test('cadastro valida handshake e guarda credenciais sem retornar o token', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/register');
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { name: 'Teste', webhook: 'https://teste.ngrok.app' });
      const handshake = await app.inject({ method: 'POST', url: '/check', payload: { token: 'credential-test' } });
      assert.deepEqual(handshake.json(), { token: 'credential-test' });
      return Response.json({ cid: 'cid-test', token: 'credential-test' });
    };
    const service = new IntegrationService(new PlatformClient('https://platform.test', fetcher), integrations, batches);
    const result = await service.register(' Teste ', 'https://teste.ngrok.app/');
    assert.deepEqual(result, { cid: 'cid-test', webhook: 'https://teste.ngrok.app' });
    assert.equal((await integrations.find('cid-test'))?.token, 'credential-test');
    await assert.rejects(service.register('Teste', 'http://teste.ngrok.app'), /HTTPS/);
    await assert.rejects(service.register('', 'https://teste.ngrok.app'), /nome/);
  });

  await t.test('recebimento anterior à resposta de burst preserva itens e completa metadados', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/burst/cid-test');
      assert.equal(new Headers(init?.headers).get('x-token'), 'credential-test');
      assert.equal(new Headers(init?.headers).get('content-type'), null,
        'Burst não tem corpo: o backend real recusa content-type JSON sem conteúdo.');
      assert.equal(init?.body, undefined);
      const early = await post({ run_id: 'early-run', seq: 9, sku: 'oleo' });
      assert.equal(early.statusCode, 202);
      return Response.json({ run_id: 'early-run', total: 20, started_at: '2026-08-03T12:00:00Z' });
    };
    const service = new IntegrationService(new PlatformClient('https://platform.test', fetcher), integrations, batches);
    assert.equal((await service.requestBatch('cid-test')).run_id, 'early-run');
    const run = await pool.query('SELECT cid, expected_total FROM runs WHERE run_id = $1', ['early-run']);
    assert.deepEqual(run.rows[0], { cid: 'cid-test', expected_total: 20 });
    const items = await pool.query('SELECT count(*)::int AS count FROM items WHERE run_id = $1', ['early-run']);
    assert.equal(items.rows[0].count, 1);
    await assert.rejects(batches.save('cid-test', { run_id: 'early-run', total: 99, started_at: '2026-08-03T12:00:00Z' }), /conflitam/);
  });

  await t.test('falhas e respostas inválidas da plataforma não são tratadas como sucesso', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls += 1; return Response.json({ error: 'handshake_failed' }, { status: 422 }); };
    const service = new IntegrationService(new PlatformClient('https://platform.test', fetcher), integrations, batches);
    await assert.rejects(service.register('Teste', 'https://teste.ngrok.app'), /webhook/);
    assert.equal(calls, 1);
    const invalid = new PlatformClient('https://platform.test', async () => Response.json({ cid: 'sem-token' }));
    await assert.rejects(invalid.register('Teste', 'https://teste.ngrok.app'), PlatformError);
    const runs = new PlatformClient('https://platform.test', async () => Response.json({ run_id: 'bad', total: 0, started_at: 'invalid' }));
    await assert.rejects(runs.burst('cid-test', 'credential-test'), PlatformError);
    const failing = new PlatformClient('https://platform.test', async () => { calls += 1; throw new Error('network'); });
    await assert.rejects(failing.burst('cid-test', 'credential-test'), PlatformError);
    const rejected = new PlatformClient('https://platform.test', async () =>
      Response.json({ error: 'request_error', reason: 'Cabeçalho inválido: credential-test' }, { status: 400 }));
    await assert.rejects(rejected.burst('cid-test','credential-test'), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.status,400);
      assert.match(error.message,/request_error/);
      assert.equal(error.message.includes('credential-test'),false);
      return true;
    });
    assert.equal(calls, 2); // A chamada que cria lotes não é repetida automaticamente.
    await assert.rejects(service.requestBatch('unknown-cid'), /não encontrada/);
    assert.equal(calls, 2);
  });

  await t.test('Redis indisponível não impede ACK de um trabalho guardado no PostgreSQL', async () => {
    redis.disconnect();
    const response = await post({ run_id: 'redis-down-run', seq: 0, sku: 'duravel' });
    assert.equal(response.statusCode, 202);
    const jobs = await pool.query('SELECT count(*)::int AS count FROM outbox WHERE run_id = $1', ['redis-down-run']);
    assert.equal(jobs.rows[0].count, 1);
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/ready' })).statusCode, 503);
  });
});
