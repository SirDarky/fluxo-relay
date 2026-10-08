import type { FastifyInstance } from 'fastify';

export async function checkRoute(app: FastifyInstance) {
  // Rota da API: o token chega antes das credenciais retornadas por /register.
  app.post<{ Body: { token: string } }>('/check', {
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string', minLength: 1 } },
      },
    },
  }, async (request) => ({ token: request.body.token }));
}
