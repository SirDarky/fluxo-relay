import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Executado pelo Docker para verificar somente a saúde do worker.
try {
  const timestamp = Number(await readFile(join(tmpdir(), 'fluxo-relay-worker-ready'), 'utf8'));
  const age = Date.now() - timestamp;
  process.exitCode = Number.isFinite(timestamp) && age >= 0 && age < 20000 ? 0 : 1;
} catch {
  process.exitCode = 1;
}
