// Contrato da fila compartilhado entre publicadores e consumidores.
// Filas independentes para diagnóstico, enriquecimento e entrega do lote.
export const infrastructureQueueName = 'fluxo-relay-infrastructure';
export const productsQueueName = 'fluxo-relay-products';
export const callbacksQueueName = 'fluxo-relay-callbacks';

export interface ProductJob { run_id: string; seq: number }
export interface CallbackJob { run_id: string }

export interface InfrastructureProbe {
  message: string;
}

export interface InfrastructureResult {
  received: string;
  processedBy: 'worker';
}
