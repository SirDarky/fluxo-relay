import Fastify from 'fastify';

// O túnel acessa este serviço, que expõe somente o contrato de recebimento.
// Painel, WebSocket e comandos administrativos continuam apenas na API local.
export function buildWebhookGateway(upstream: string, timeoutMs = 2500) {
  const app = Fastify({ bodyLimit: 32768, logger: false });
  for (const path of ['/check', '/process']) {
    app.post(path, async (request, reply) => {
      try {
        const response = await fetch(new URL(path, upstream), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request.body), redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        return reply.code(response.status).type('application/json').send(await response.text());
      } catch {
        return reply.code(503).send({ error: 'API_UNAVAILABLE', message: 'Recebimento indisponível. Tente novamente.' });
      }
    });
  }
  return app;
}
