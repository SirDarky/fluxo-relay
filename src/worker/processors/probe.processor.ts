import type { InfrastructureProbe, InfrastructureResult } from '../../shared/contracts/queues.js';
import { database } from '../../shared/infra/database.js';

export async function processProbe(data: InfrastructureProbe): Promise<InfrastructureResult> {
  if (typeof data?.message !== 'string') {
    throw new Error('Diagnóstico precisa de uma mensagem de texto.');
  }
  await database.query('SELECT 1');
  return { received: data.message, processedBy: 'worker' };
}
