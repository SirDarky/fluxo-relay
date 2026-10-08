import type { Burst, Registration } from '../../../shared/contracts/platform.js';

export class PlatformError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class PlatformClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = fetch) {}

  private async post(path: string, body?: unknown, token?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { 'x-token': token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new PlatformError('Não foi possível confirmar a chamada à plataforma. Verifique a conexão antes de repetir.');
    }
    if (!response.ok) {
      let detail = '';
      try {
        const body: unknown = await response.json();
        if (record(body)) detail = [body.error,body.reason,body.message]
          .filter((value): value is string => typeof value === 'string')
          .map((value) => token ? value.replaceAll(token,'[token omitido]') : value)
          .join(' · ').replace(/[\r\n]/g,' ').slice(0,240);
      } catch { /* O status HTTP continua sendo a informação principal. */ }
      const message = path === '/register' && response.status === 422
        ? 'A plataforma não validou o webhook. Confira a URL HTTPS e a rota /check.'
        : `A plataforma recusou a chamada (HTTP ${response.status}).`;
      throw new PlatformError(`${message}${detail ? ` ${detail}` : ''}`, response.status);
    }
    try { return await response.json(); } catch {
      throw new PlatformError('A plataforma retornou uma resposta que não é JSON.');
    }
  }

  async register(name: string, webhook: string): Promise<Registration> {
    const data = await this.post('/register', { name, webhook });
    if (!record(data) || !text(data.cid) || !text(data.token)) {
      throw new PlatformError('A resposta do cadastro não contém cid e token válidos.');
    }
    return { cid: data.cid, token: data.token };
  }

  async burst(cid: string, token: string): Promise<Burst> {
    const data = await this.post(`/burst/${encodeURIComponent(cid)}`, undefined, token);
    if (!record(data) || !text(data.run_id) || typeof data.total !== 'number'
      || !Number.isSafeInteger(data.total) || data.total < 1 || data.total > 2147483647
      || !text(data.started_at) || !Number.isFinite(Date.parse(data.started_at))) {
      throw new PlatformError('A resposta do lote não contém run_id, total e started_at válidos.');
    }
    return { run_id: data.run_id, total: data.total, started_at: data.started_at };
  }
}
