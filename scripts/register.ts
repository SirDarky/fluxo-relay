import { parseArgs } from 'node:util';
import { database } from '../src/shared/infra/database.js';
import { env } from '../src/shared/config/env.js';
import { migrate } from '../src/shared/infra/migrate.js';
import { PlatformClient } from '../src/api/modules/integration/platform-client.js';
import { IntegrationRepository } from '../src/api/modules/integration/integration.repository.js';
import { IntegrationService } from '../src/api/modules/integration/integration.service.js';
import { BatchRepository } from '../src/api/modules/batches/batch.repository.js';

try {
  if (!env.processingEnabled) throw new Error('Ative PROCESSING_ENABLED=true antes do cadastro real.');
  const { values } = parseArgs({ options: { name: { type: 'string' }, webhook: { type: 'string' } } });
  if (!values.name || !values.webhook) {
    throw new Error('Uso: npm run integration:register -- --name "Seu Nome" --webhook "https://seu-endereco.ngrok.app"');
  }
  await migrate(database);
  const service = new IntegrationService(new PlatformClient(env.platformBaseUrl), new IntegrationRepository(database), new BatchRepository(database));
  const result = await service.register(values.name, values.webhook);
  console.log(`Integração cadastrada: ${result.cid}. Webhook: ${result.webhook}. Token guardado no banco.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Falha no cadastro.');
  process.exitCode = 1;
} finally { await database.end(); }
