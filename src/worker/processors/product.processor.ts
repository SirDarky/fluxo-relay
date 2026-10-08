import type { ProductJob } from '../../shared/contracts/queues.js';
import { WorkRepository } from '../repositories/work.repository.js';
import { WorkerPlatformClient, RemoteError } from '../integration/platform-client.js';
import { retryDecision, type RetryPolicy } from '../retry.js';

export function productProcessor(repository: WorkRepository, platform: WorkerPlatformClient, policy: RetryPolicy) {
  return async (message: ProductJob) => repository.lock(message, async (client) => {
    const item = await repository.context(client, message);
    if (!item || item.state === 'completed' || item.state === 'failed' || item.next_attempt_at.getTime() > Date.now()) return;
    if (item.attempts >= policy.maxAttempts) {
      await repository.failed(client, message, true, new Date(), 'Limite de tentativas atingido após interrupção.');
      return;
    }
    const attempt = await repository.begin(client, message);
    const started = performance.now();
    try {
      const result = await platform.enrich(item.sku, item.cid, item.token);
      await repository.finishAttempt(client, message, attempt, performance.now() - started, result.httpStatus);
      await repository.complete(client, message, result);
    } catch (error) {
      await repository.finishAttempt(client, message, attempt, performance.now() - started, error instanceof RemoteError ? error.status : undefined);
      const retry = retryDecision(error, attempt, policy);
      await repository.failed(client, message, retry.terminal, retry.nextAttempt, retry.message);
    }
  });
}
