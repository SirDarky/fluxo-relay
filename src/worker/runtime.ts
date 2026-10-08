import { Queue, Worker } from 'bullmq';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { productsQueueName, callbacksQueueName, type ProductJob, type CallbackJob } from '../shared/contracts/queues.js';
import { WorkRepository } from './repositories/work.repository.js';
import { DeliveryRepository } from './repositories/delivery.repository.js';
import { OutboxPublisher } from './publishers/outbox.publisher.js';
import { productProcessor } from './processors/product.processor.js';
import { callbackProcessor } from './processors/callback.processor.js';
import { WorkerPlatformClient } from './integration/platform-client.js';
import { defaultRetryPolicy, validateRetryPolicy, type RetryPolicy } from './retry.js';

export interface RuntimeOptions {
  pool: Pool;
  connection: Redis;
  producerConnection: Redis;
  platform: WorkerPlatformClient;
  queuePrefix?: string;
  pollMs?: number;
  staleMs?: number;
  recheckMs?: number;
  retryPolicy?: RetryPolicy;
  onError?: (error: Error) => void;
  source?: 'local' | 'remote';
}

export function createWorkerRuntime(options: RuntimeOptions) {
  validateRetryPolicy(options.retryPolicy ?? defaultRetryPolicy);
  const onError = options.onError ?? ((error: Error) => console.error(error.message));
  const prefix = options.queuePrefix ?? 'bull';
  const products = new Queue<ProductJob>(productsQueueName, { connection: options.producerConnection, prefix });
  const callbacks = new Queue<CallbackJob>(callbacksQueueName, { connection: options.producerConnection, prefix });
  const works = new WorkRepository(options.pool, options.source ?? 'remote');
  const deliveries = new DeliveryRepository(options.pool, options.source ?? 'remote');
  const policy = options.retryPolicy ?? defaultRetryPolicy;
  const publisher = new OutboxPublisher(works, deliveries, products, callbacks, options.staleMs, options.recheckMs);
  const product = productProcessor(works, options.platform, policy);
  const callback = callbackProcessor(deliveries, options.platform, policy);
  const productWorker = new Worker<ProductJob>(productsQueueName, async (job) => {
    if (job.name !== 'enrich') throw new Error('Tipo de trabalho de produto desconhecido.');
    return product(job.data);
  }, { connection: options.connection, prefix, concurrency: 3, autorun: false });
  const callbackWorker = new Worker<CallbackJob>(callbacksQueueName, async (job) => {
    if (job.name !== 'callback') throw new Error('Tipo de callback desconhecido.');
    return callback(job.data);
  }, { connection: options.connection, prefix, concurrency: 1, autorun: false });
  products.on('error', onError);
  callbacks.on('error', onError);
  productWorker.on('error', onError);
  callbackWorker.on('error', onError);
  productWorker.on('failed', (_job, error) => onError(error));
  callbackWorker.on('failed', (_job, error) => onError(error));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let task: Promise<void> | undefined;
  function schedule() {
    timer = setTimeout(() => {
      task = publisher.publish().catch(onError);
      void task.then(() => { if (!stopped) schedule(); });
    }, options.pollMs ?? 250);
  }

  return {
    products, callbacks, publisher,
    isRunning: () => !stopped && productWorker.isRunning() && callbackWorker.isRunning(),
    async start() {
      await products.setGlobalConcurrency(3);
      await callbacks.setGlobalConcurrency(1);
      await Promise.all([productWorker.waitUntilReady(), callbackWorker.waitUntilReady()]);
      void productWorker.run().catch(onError);
      void callbackWorker.run().catch(onError);
      task = publisher.publish().catch(onError);
      await task;
      schedule();
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      await task;
      await Promise.all([productWorker.close(), callbackWorker.close()]);
      await Promise.all([products.close(), callbacks.close()]);
    },
  };
}
