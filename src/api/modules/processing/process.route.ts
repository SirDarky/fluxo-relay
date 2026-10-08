import type { FastifyInstance } from 'fastify';
import type { ProcessMessage } from '../../../shared/contracts/processing.js';
import { ItemRepository } from './item.repository.js';
import { receiveItem } from './receive-item.js';

export async function processRoute(app: FastifyInstance, options: { repository: ItemRepository }) {
  app.post<{ Body: ProcessMessage }>('/process', {
    schema: {
      body: {
        type: 'object',
        required: ['run_id', 'seq', 'sku'],
        properties: {
          run_id: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' },
          seq: { type: 'integer', minimum: 0, maximum: 2147483647 },
          sku: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' },
        },
      },
      response: {
        202: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      },
    },
  }, async (request, reply) => {
    const result = await receiveItem(options.repository, request.body);
    request.log.info({ runId: request.body.run_id, seq: request.body.seq, duplicate: result.duplicate }, 'Mensagem guardada');
    return reply.code(202).send({ ok: true });
  });
}
