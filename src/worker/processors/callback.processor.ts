import type { CallbackJob } from '../../shared/contracts/queues.js';
import { DeliveryRepository } from '../repositories/delivery.repository.js';
import { WorkerPlatformClient, RemoteError } from '../integration/platform-client.js';
import { retryDecision, type RetryPolicy } from '../retry.js';

export function callbackProcessor(repository: DeliveryRepository, platform: WorkerPlatformClient, policy: RetryPolicy) {
  return async ({ run_id }: CallbackJob) => repository.lock(run_id, async (client) => {
    const context = await repository.context(client, run_id);
    if (!context || context.delivery_state === 'delivered' || context.delivery_state === 'failed'
      || context.callback_next_attempt_at.getTime() > Date.now()) return;
    const payload = await repository.payload(client, context);
    if (!payload) return;
    if (context.callback_attempts >= policy.maxAttempts) {
      await repository.failed(client, run_id, undefined, true, new Date(), 'Limite de envios atingido após interrupção.');
      return;
    }
    const attempt = await repository.begin(client, payload);
    try {
      const response = await platform.callback(payload, context.token);
      await repository.complete(client, run_id, attempt.id, response);
    } catch (error) {
      const retry = retryDecision(error, attempt.attempt, policy);
      await repository.failed(client, run_id, attempt.id, retry.terminal, retry.nextAttempt, retry.message,
        error instanceof RemoteError ? error.status : undefined);
    }
  });
}
