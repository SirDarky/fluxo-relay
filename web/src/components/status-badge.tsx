import { Badge } from "@/components/ui/badge";
import type { DashboardRun } from "../../../src/shared/contracts/dashboard";

const labels: Record<string, string> = {
  pending: "Na fila",
  processing: "Processando",
  completed: "Pronto",
  failed: "Falhou",
  waiting: "Aguardando",
  sending: "Enviando",
  delivered: "Concluído",
};
export function StatusBadge({ state }: { state: string }) {
  return (
    <Badge variant="outline" className={`status-badge status-${state}`}>
      <span className="status-dot" />
      {labels[state] ?? state}
    </Badge>
  );
}
export function runState(run: DashboardRun) {
  if (run.failed || run.delivery_state === "failed") return "failed";
  if (run.delivery_state === "delivered" || run.delivery_state === "sending")
    return run.delivery_state;
  if (run.processing || run.completed) return "processing";
  return "waiting";
}
