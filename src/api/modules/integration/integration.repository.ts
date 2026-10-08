import type { Pool } from 'pg';
import type { Registration } from '../../../shared/contracts/platform.js';

export interface SavedIntegration extends Registration {
  name: string;
  webhook: string;
}

export class IntegrationRepository {
  constructor(private readonly pool: Pool) {}

  async save(integration: SavedIntegration) {
    await this.pool.query(`
      INSERT INTO integrations (cid, name, webhook, token) VALUES ($1, $2, $3, $4)
      ON CONFLICT (cid) DO UPDATE SET
        name = EXCLUDED.name, webhook = EXCLUDED.webhook,
        token = EXCLUDED.token, updated_at = now()
    `, [integration.cid, integration.name, integration.webhook, integration.token]);
  }

  async find(cid?: string): Promise<SavedIntegration | undefined> {
    const result = cid
      ? await this.pool.query<SavedIntegration>('SELECT cid, name, webhook, token FROM integrations WHERE cid = $1', [cid])
      : await this.pool.query<SavedIntegration>(`SELECT cid, name, webhook, token FROM integrations
          WHERE cid <> 'local-simulator' ORDER BY updated_at DESC, cid LIMIT 1`);
    return result.rows[0];
  }
}
