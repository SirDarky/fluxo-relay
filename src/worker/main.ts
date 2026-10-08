import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'bullmq';
import { database } from '../shared/infra/database.js';
import { createRedis, redis } from '../shared/infra/redis.js';
import { infrastructureQueueName, type InfrastructureProbe, type InfrastructureResult } from '../shared/contracts/queues.js';
import { processProbe } from './processors/probe.processor.js';
import { env } from '../shared/config/env.js';
import { migrate } from '../shared/infra/migrate.js';
import { createWorkerRuntime } from './runtime.js';
import { WorkerPlatformClient } from './integration/platform-client.js';

const readinessFile = join(tmpdir(), 'fluxo-relay-worker-ready');
const connection = createRedis('worker');
const runtime = env.processingEnabled ? createWorkerRuntime({
  pool: database, connection, producerConnection: redis,
  platform: new WorkerPlatformClient(env.platformBaseUrl), onError: logError,
  retryPolicy: env.retryPolicy,
}) : undefined;
// Simulação usa fila e seleção no banco separadas dos lotes reais.
const localRuntime = env.simulationEnabled ? createWorkerRuntime({
  pool: database, connection, producerConnection: redis, source: 'local', queuePrefix: 'fluxo-relay-local',
  platform: new WorkerPlatformClient(env.simulatorBaseUrl), onError: logError,
  retryPolicy: env.retryPolicy,
}) : undefined;
const worker = new Worker<InfrastructureProbe, InfrastructureResult>(
  infrastructureQueueName,
  async (job) => {
    if (job.name !== 'probe') throw new Error(`Trabalho desconhecido: ${job.name}`);
    return processProbe(job.data);
  },
  { connection, concurrency: 1 },
);

function logError(error: Error) {
  console.error(JSON.stringify({ role: 'worker', level: 'error', message: error.message }));
}
database.on('error', logError);
redis.on('error', logError);
connection.on('error', logError);
worker.on('error', logError);
worker.on('failed', (job, error) => {
  console.error(JSON.stringify({ role: 'worker', jobId: job?.id, message: error.message }));
});

let shuttingDown = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let healthTask: Promise<void> | undefined;

async function refreshHealth() {
  try {
    await Promise.all([database.query('SELECT 1'), redis.ping()]);
    if (shuttingDown || !worker.isRunning() || (runtime && !runtime.isRunning()) || (localRuntime && !localRuntime.isRunning())) return;
    await writeFile(readinessFile, String(Date.now()));
  } catch (error) {
    logError(error as Error);
    await rm(readinessFile, { force: true });
  }
}

function scheduleHealth() {
  timer = setTimeout(() => {
    healthTask = refreshHealth();
    void healthTask.finally(() => { if (!shuttingDown) scheduleHealth(); });
  }, 5000);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(timer);
  await healthTask;
  await rm(readinessFile, { force: true });
  await worker.close();
  await runtime?.close();
  await localRuntime?.close();
  connection.disconnect();
  redis.disconnect();
  await database.end();
}

process.once('SIGINT', () => { void shutdown().catch(logError); });
process.once('SIGTERM', () => { void shutdown().catch(logError); });

try {
  await migrate(database);
  await worker.waitUntilReady();
  await runtime?.start();
  await localRuntime?.start();
  healthTask = refreshHealth();
  await healthTask;
  scheduleHealth();
  console.log(JSON.stringify({ role: 'worker', message: 'Worker iniciado', queue: infrastructureQueueName, processingEnabled: env.processingEnabled }));
} catch (error) {
  logError(error as Error);
  process.exitCode = 1;
  await shutdown();
}
