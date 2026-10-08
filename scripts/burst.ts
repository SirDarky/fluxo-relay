import { parseArgs } from 'node:util';
import { database } from '../src/shared/infra/database.js';
import { env } from '../src/shared/config/env.js';
import { migrate } from '../src/shared/infra/migrate.js';
import { PlatformClient } from '../src/api/modules/integration/platform-client.js';
import { IntegrationRepository } from '../src/api/modules/integration/integration.repository.js';
import { IntegrationService } from '../src/api/modules/integration/integration.service.js';
import { BatchRepository } from '../src/api/modules/batches/batch.repository.js';

try {
  if (!env.processingEnabled) throw new Error('Ative PROCESSING_ENABLED=true antes de solicitar um lote real.');
  const { values } = parseArgs({ options: { cid: { type: 'string' } } });
  await migrate(database);
  const service = new IntegrationService(new PlatformClient(env.platformBaseUrl), new IntegrationRepository(database), new BatchRepository(database));
  const burst = await service.requestBatch(values.cid);
  console.log(JSON.stringify(burst, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Falha ao solicitar lote.');
  process.exitCode = 1;
} finally { await database.end(); }
