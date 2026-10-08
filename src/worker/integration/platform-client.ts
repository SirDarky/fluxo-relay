import type { CallbackPayload, CallbackResponse, EnrichedProduct } from '../../shared/contracts/platform.js';

export class RemoteError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly retryAfterMs = 0, public readonly status?: number) {
    super(message);
  }
}

export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export class WorkerPlatformClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      const response = await this.fetcher(new URL(path, this.baseUrl), {
        ...init, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
        const wait = retryAfterMs(response.headers.get('retry-after'));
        await response.body?.cancel();
        throw new RemoteError(`Plataforma retornou HTTP ${response.status}.`, retryable, wait, response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError('Falha de conexão ou timeout da plataforma.', true);
    }
  }

  async enrich(sku: string, cid: string, token: string): Promise<EnrichedProduct & { httpStatus: number }> {
    const response = await this.request(`/enrich/${encodeURIComponent(sku)}`, {
      method: 'GET', headers: { 'x-cid': cid, 'x-token': token },
    });
    let data: unknown;
    try { data = await response.json(); } catch {
      throw new RemoteError('Resposta de enriquecimento inválida ou interrompida.', true);
    }
    if (typeof data !== 'object' || data === null) throw new RemoteError('Enriquecimento não é um objeto JSON.', false);
    const item = data as Record<string, unknown>;
    if (item.sku !== sku || typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0
      || typeof item.stock !== 'number' || !Number.isInteger(item.stock) || item.stock < 0 || item.stock > 2147483647) {
      throw new RemoteError('SKU, preço ou estoque inválido no enriquecimento.', false);
    }
    return { sku, price: item.price, stock: item.stock, httpStatus: response.status };
  }

  async callback(payload: CallbackPayload, token: string): Promise<CallbackResponse> {
    const response = await this.request('/callback', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token },
      body: JSON.stringify(payload),
    });
    let text: string;
    try { text = await response.text(); } catch {
      throw new RemoteError('A resposta do callback foi interrompida; o envio pode ter sido aceito.', true);
    }
    let body: unknown = text || null;
    try { if (text) body = JSON.parse(text); } catch { /* Preservamos respostas em texto também. */ }
    return { status: response.status, body };
  }
}
