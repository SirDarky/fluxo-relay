import { Redis } from 'ioredis';
import { env } from '../config/env.js';

// Compartilhamos a fábrica; API e worker mantêm conexões independentes.
export function createRedis(role: 'request' | 'worker' = 'request') {
  return new Redis(env.redisUrl, {
    maxRetriesPerRequest: role === 'worker' ? null : 1,
    connectTimeout: 2000,
    // O worker usa chamadas bloqueantes; não deve ter um timeout curto de comando.
    ...(role === 'request' ? { commandTimeout: 2000 } : {}),
  });
}

export const redis = createRedis();
