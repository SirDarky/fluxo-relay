export type ProcessingStage = "received" | "processing" | "sent";

// Enriquecimento concluído ainda não significa que a plataforma recebeu o lote.
export function processingStage(
  item: { state: string; attempts: number },
  run: { delivery_state: string },
): ProcessingStage {
  if (item.state === "completed" && run.delivery_state === "delivered")
    return "sent";
  if (
    item.state === "failed" ||
    (item.state === "pending" && item.attempts === 0)
  )
    return "received";
  return "processing";
}
