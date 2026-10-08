import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { buildWebhookGateway } from '../src/webhook/app.js';

test('gateway público preserva o contrato e não expõe o painel', async (t) => {
  const upstream = Fastify();
  const messages: unknown[] = [];
  upstream.post<{ Body: { token: string } }>('/check', async (request) => ({ token: request.body.token }));
  upstream.post('/process', async (request, reply) => {
    messages.push(request.body);
    return reply.code(202).send({ ok: true });
  });
  const address = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const gateway = buildWebhookGateway(address);
  t.after(async () => { await gateway.close(); await upstream.close(); });
  const check = await gateway.inject({ method: 'POST', url: '/check', payload: { token: 'local-probe' } });
  assert.equal(check.statusCode, 200);
  assert.deepEqual(check.json(), { token: 'local-probe' });
  const payload = { run_id: 'run', seq: 0, sku: 'sku' };
  const received = await gateway.inject({ method: 'POST', url: '/process', payload });
  assert.equal(received.statusCode, 202);
  assert.deepEqual(messages, [payload]);
  for (const url of ['/', '/dashboard/snapshot', '/dashboard/ws', '/dashboard/integration', '/process/other'])
    assert.equal((await gateway.inject({ method: 'POST', url, payload: {} })).statusCode, 404);
  assert.equal((await gateway.inject('/check')).statusCode, 404);
  await upstream.close();
  assert.equal((await gateway.inject({ method: 'POST', url: '/process', payload })).statusCode, 503);
});
