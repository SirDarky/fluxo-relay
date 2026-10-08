import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { ProductJob, CallbackJob } from '../../shared/contracts/queues.js';
import { WorkRepository } from '../repositories/work.repository.js';
import { DeliveryRepository } from '../repositories/delivery.repository.js';

// A identidade da tentativa evita republicação duplicada; a autoridade é o banco.
async function ensureJob(queue: Pick<Queue, 'getJob'>, id: string, add: () => Promise<unknown>) {
  const previous = await queue.getJob(id);
  if (previous) {
    const state = await previous.getState();
    if (state === 'completed' || state === 'failed') await previous.remove();
    else return;
  }
  await add();
}

const retention = { removeOnComplete: { age: 86400, count: 5000 }, removeOnFail: { age: 86400, count: 5000 } };

export class OutboxPublisher {
  constructor(
    private readonly works: WorkRepository,
    private readonly deliveries: DeliveryRepository,
    private readonly products: Queue<ProductJob>,
    private readonly callbacks: Queue<CallbackJob>,
    private readonly staleMs = 15000,
    private readonly recheckMs = 2000,
  ) {}

  async publish() {
    // Reaplicamos antes de publicar: o limite também precisa sobreviver à perda de dados do Redis.
    await this.products.setGlobalConcurrency(3);
    await this.callbacks.setGlobalConcurrency(1);
    for (const work of await this.works.candidates(this.staleMs, this.recheckMs)) {
      const id = `item-${work.id}-${work.attempts}`;
      await ensureJob(this.products, id, () => this.products.add('enrich', { run_id: work.run_id, seq: work.seq }, { ...retention, jobId: id }));
      await this.works.published(work.id);
    }
    for (const run of await this.deliveries.candidates(this.staleMs)) {
      const key = createHash('sha256').update(run.run_id).digest('hex');
      const id = `callback-${key}-${run.callback_attempts}`;
      await ensureJob(this.callbacks, id, () => this.callbacks.add('callback', { run_id: run.run_id }, { ...retention, jobId: id }));
    }
  }
}
