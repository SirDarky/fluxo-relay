// Mensagem recebida pelo webhook e persistida para processamento pelo worker.
export interface ProcessMessage {
  run_id: string;
  seq: number;
  sku: string;
}
