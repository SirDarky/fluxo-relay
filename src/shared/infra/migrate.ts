import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

const directory = new URL('../../../migrations/', import.meta.url);

export async function migrate(pool: Pool): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('BEGIN');
    // Evita duas APIs executando as mesmas migrations simultaneamente.
    await client.query('SELECT pg_advisory_xact_lock(733103)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied: string[] = [];
    for (const name of names) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1', [name],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum) {
          throw new Error(`Migration ${name} foi alterada após aplicação. Crie uma nova migration.`);
        }
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      applied.push(name);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroy = true; }
    throw error;
  } finally { client.release(destroy); }
}
