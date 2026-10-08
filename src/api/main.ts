import { env } from '../shared/config/env.js';
import { buildApp } from './app.js';
import { database } from '../shared/infra/database.js';
import { migrate } from '../shared/infra/migrate.js';

const app = buildApp();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

try {
  const migrations = await migrate(database);
  if (migrations.length) app.log.info({ migrations }, 'Banco atualizado');
  await app.listen({ port: env.apiPort, host: env.host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await shutdown();
}
