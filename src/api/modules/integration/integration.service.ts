import { IntegrationRepository } from './integration.repository.js';
import { PlatformClient } from './platform-client.js';
import { BatchRepository } from '../batches/batch.repository.js';

export class IntegrationService {
  constructor(
    private readonly client: PlatformClient,
    private readonly integrations: IntegrationRepository,
    private readonly batches: BatchRepository,
  ) {}

  async register(name: string, webhook: string) {
    if (!name.trim()) throw new Error('Informe seu nome.');
    let url: URL;
    try { url = new URL(webhook); } catch { throw new Error('Informe uma URL pública válida.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('O webhook precisa ser uma URL HTTPS sem credenciais, query ou fragmento.');
    }
    const normalized = url.toString().replace(/\/$/, '');
    const registration = await this.client.register(name.trim(), normalized);
    try {
      await this.integrations.save({ ...registration, name: name.trim(), webhook: normalized });
    } catch {
      throw new Error('A plataforma cadastrou o serviço, mas as credenciais não puderam ser guardadas. Execute o cadastro novamente após recuperar o banco.');
    }
    // O comando não retorna nem imprime o token.
    return { cid: registration.cid, webhook: normalized };
  }

  async requestBatch(cid?: string) {
    if (cid === 'local-simulator') throw new Error('Use o controle de simulação para iniciar um lote local.');
    const integration = await this.integrations.find(cid);
    if (!integration) throw new Error('Integração não encontrada. Execute o comando de cadastro primeiro.');
    // /burst cria uma execução nova: não fazemos retry automático desta chamada.
    const burst = await this.client.burst(integration.cid, integration.token);
    try { await this.batches.save(integration.cid, burst); } catch {
      throw new Error(`O lote ${burst.run_id} foi solicitado, mas seus dados não puderam ser guardados. Não solicite outro lote para tentar corrigir este.`);
    }
    return burst;
  }
}
