import { database } from '../src/shared/infra/database.js';
import { migrate } from '../src/shared/infra/migrate.js';

try {
  const names = await migrate(database);
  console.log(names.length ? `Migrations aplicadas: ${names.join(', ')}` : 'Banco já está atualizado.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Falha ao preparar o banco.');
  process.exitCode = 1;
} finally { await database.end(); }
