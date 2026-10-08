import { useState } from "react";
import { Inbox, LoaderCircle, Send } from "lucide-react";
import type {
  DashboardItem,
  DashboardRun,
} from "../../../src/shared/contracts/dashboard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { dateTime, milliseconds, time } from "@/lib/format";
import { processingStage, type ProcessingStage } from "@/lib/processing-stage";

const columns = [
  {
    id: "received",
    title: "Recebidos",
    description: "Chegaram e aguardam a consulta",
    empty: "Nenhum item aguardando",
    icon: Inbox,
  },
  {
    id: "processing",
    title: "Processando",
    description: "Em consulta ou aguardando o envio",
    empty: "Nenhum item em processamento",
    icon: LoaderCircle,
  },
  {
    id: "sent",
    title: "Processados e enviados",
    description: "Envio do lote confirmado",
    empty: "Nenhum envio confirmado ainda",
    icon: Send,
  },
] as const;

function status(
  item: DashboardItem,
  stage: ProcessingStage,
  run: DashboardRun,
) {
  if (stage === "sent") return "Envio confirmado";
  if (item.state === "failed") return "Falha no processamento";
  if (item.state === "completed")
    return run.delivery_state === "failed"
      ? "Falha no envio do lote"
      : "Pronto · aguardando envio";
  if (item.state === "pending" && item.attempts > 0)
    return "Aguardando nova tentativa";
  return stage === "received"
    ? "Aguardando processamento"
    : "Consultando preço e estoque";
}

export function ProcessingBoard({
  items,
  run,
}: {
  items: DashboardItem[];
  run: DashboardRun;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  // Mantém os detalhes atualizados com o WebSocket, inclusive com o diálogo aberto.
  const item = items.find((entry) => entry.seq === selected);
  return (
    <>
      <div className="processing-board">
        {columns.map((column) => {
          const entries = items.filter(
            (entry) => processingStage(entry, run) === column.id,
          );
          const Icon = column.icon;
          return (
            <section
              key={column.id}
              className={`stage-column stage-${column.id}`}
              aria-label={column.title}
            >
              <div className="stage-heading">
                <Icon />
                <h3>{column.title}</h3>
                <span>{entries.length}</span>
              </div>
              <p className="stage-description">{column.description}</p>
              <div className="stage-items">
                {entries.length ? (
                  entries.map((entry) => (
                    <button
                      type="button"
                      key={entry.seq}
                      className={`stage-item ${entry.state === "failed" ? "stage-item-failed" : ""}`}
                      aria-label={`Ver detalhes do item ${entry.seq}`}
                      onClick={() => setSelected(entry.seq)}
                    >
                      <div>
                        <strong>Item {entry.seq}</strong>
                        <time>
                          {time(
                            column.id === "sent" && run.delivered_at
                              ? run.delivered_at
                              : entry.received_at,
                          )}
                        </time>
                      </div>
                      <span className="stage-sku mono" title={entry.sku}>
                        {entry.sku}
                      </span>
                      <small>{status(entry, column.id, run)}</small>
                    </button>
                  ))
                ) : (
                  <p className="stage-empty">{column.empty}</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <p className="board-hint">
        Clique em um item para ver o JSON, os horários e as tentativas. O verde
        aparece após a confirmação do envio do lote.
      </p>
      <Dialog
        open={!!item}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="item-detail-dialog">
          {item && (
            <>
              <DialogHeader>
                <DialogTitle>Item {item.seq}</DialogTitle>
                <DialogDescription>
                  {status(item, processingStage(item, run), run)} ·{" "}
                  {run.source === "local"
                    ? "Simulação local"
                    : "Plataforma da empresa"}
                </DialogDescription>
              </DialogHeader>
              <dl className="item-detail-times">
                <div>
                  <dt>Chegou em</dt>
                  <dd>{dateTime(item.received_at, true)}</dd>
                </div>
                <div>
                  <dt>Início do processamento</dt>
                  <dd>
                    {item.processing_started_at
                      ? dateTime(item.processing_started_at, true)
                      : "Ainda não iniciou"}
                  </dd>
                </div>
                <div>
                  <dt>Término do processamento</dt>
                  <dd>
                    {item.processing_finished_at
                      ? dateTime(item.processing_finished_at, true)
                      : "Ainda não terminou"}
                  </dd>
                </div>
                <div>
                  <dt>Duração do processamento</dt>
                  <dd>
                    {milliseconds(item.processing_duration_ms)}
                    {item.processing_started_at && !item.processing_finished_at
                      ? " · até agora"
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>
                    Última consulta ao{" "}
                    {run.source === "local" ? "simulador" : "backend"}
                  </dt>
                  <dd>{milliseconds(item.backend_duration_ms)}</dd>
                </div>
                <div>
                  <dt>Envio do lote confirmado</dt>
                  <dd>
                    {run.delivery_state === "delivered" && run.delivered_at
                      ? dateTime(run.delivered_at, true)
                      : "Ainda não confirmado"}
                  </dd>
                </div>
              </dl>
              {item.deliveries > 1 && (
                <p className="item-detail-note">
                  Esta mensagem chegou {item.deliveries} vezes. Último
                  recebimento: {dateTime(item.last_received_at, true)}. A
                  duplicata não gera outro processamento.
                </p>
              )}
              {item.last_error && (
                <p
                  className={
                    item.state === "failed"
                      ? "error-banner"
                      : "item-detail-note"
                  }
                >
                  {item.last_error}
                  {item.state === "pending" && item.attempts > 0
                    ? ` Próxima tentativa: ${dateTime(item.next_attempt_at, true)}.`
                    : ""}
                </p>
              )}
              <div className="item-json">
                <h4>JSON recebido em /process</h4>
                <p>
                  {item.received_payload
                    ? "Campos do contrato preservados na primeira mensagem recebida."
                    : "Mensagem reconstituída: o JSON original não está disponível."}
                </p>
                <pre>
                  {JSON.stringify(
                    item.received_payload ?? {
                      run_id: run.run_id,
                      seq: item.seq,
                      sku: item.sku,
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>
              {item.state === "completed" && (
                <div className="item-json">
                  <h4>
                    {processingStage(item, run) === "sent"
                      ? "Item enviado no resultado do lote"
                      : "Resultado pronto para o envio"}
                  </h4>
                  <pre>
                    {JSON.stringify(
                      {
                        seq: item.seq,
                        sku: item.sku,
                        price: item.price,
                        stock: item.stock,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              )}
              {!!item.attempt_history.length && (
                <details className="item-detail-attempts">
                  <summary>Tentativas ({item.attempts})</summary>
                  <ol className="attempt-history">
                    {item.attempt_history.map((attempt) => (
                      <li key={attempt.attempt}>
                        <strong>Tentativa {attempt.attempt}</strong>
                        <span>
                          {attempt.http_status !== null
                            ? `HTTP ${attempt.http_status}`
                            : attempt.finished_at
                              ? "Sem resposta HTTP confirmada"
                              : attempt.attempt === item.attempts &&
                                  item.state === "processing"
                                ? "Em andamento"
                                : "Interrompida"}{" "}
                          · {milliseconds(attempt.duration_ms)}
                        </span>
                        <span>
                          Início: {dateTime(attempt.started_at, true)}
                        </span>
                        {attempt.finished_at && (
                          <span>
                            Término: {dateTime(attempt.finished_at, true)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
