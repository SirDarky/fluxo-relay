import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

export async function healthRoutes(app: FastifyInstance, options: { pool: Pool; redis: Redis }) {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    const checks = await Promise.allSettled([options.pool.query('SELECT 1'), options.redis.ping()]);
    const postgresOk = checks[0]?.status === 'fulfilled';
    const redisOk = checks[1]?.status === 'fulfilled';
    const ready = postgresOk && redisOk;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'unavailable',
      postgres: postgresOk ? 'ok' : 'unavailable',
      redis: redisOk ? 'ok' : 'unavailable',
    });
  });
}
