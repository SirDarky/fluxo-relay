import { buildWebhookGateway } from './app.js';

const port = Number(process.env.WEBHOOK_PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEBHOOK_PORT inválida.');
const app = buildWebhookGateway(process.env.WEBHOOK_UPSTREAM ?? 'http://127.0.0.1:4000');
process.once('SIGTERM', () => { void app.close(); });
process.once('SIGINT', () => { void app.close(); });
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
console.log(`Gateway do webhook iniciado na porta ${port}.`);
