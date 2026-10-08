import { useState } from "react";
import { ArrowLeft, ArrowRight, Download, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import type { DashboardSnapshot } from "../../../src/shared/contracts/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TestSummary } from "@/components/test-summary";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { ProcessingBoard } from "@/components/processing-board";
import { api, downloadJson } from "@/lib/api";
import { dateTime, milliseconds, money, shortId } from "@/lib/format";

export function Batches({
  data,
  selectRun,
  setPage,
  openLogs,
}: {
  data: DashboardSnapshot;
  selectRun: (id: string | null) => void;
  setPage: (page: number) => void;
  openLogs: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState<"board" | "table">("board");
  const [exporting, setExporting] = useState(false);
  const run = data.runs.find((item) => item.run_id === data.selectedRunId);
  async function report() {
    if (!run) return;
    setExporting(true);
    try {
      downloadJson(
        await api(`/runs/${encodeURIComponent(run.run_id)}/report`),
        `teste-${run.test_number}.json`,
      );
      toast.success("Relatório exportado.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao exportar.",
      );
    } finally {
      setExporting(false);
    }
  }
  const items = data.items.filter(
    (item) =>
      filter === "all" ||
      (filter === "pending"
        ? ["pending", "processing"].includes(item.state)
        : item.state === filter),
  );
  return (
    <div className="page-stack">
      <div>
        <Button variant="ghost" size="sm" onClick={() => selectRun(null)}>
          <ArrowLeft />
          Todos os testes
        </Button>
      </div>
      {run ? (
        <>
          <Card className="test-card">
            <CardContent>
              <TestSummary run={run} now={data.generatedAt} />
              <div className="test-card-actions">
                <Button variant="outline" onClick={openLogs}>
                  Ver logs deste teste
                </Button>
                <Button
                  variant="outline"
                  disabled={run.delivery_state !== "delivered" || exporting}
                  onClick={() => {
                    void report();
                  }}
                >
                  {exporting ? <LoaderCircle className="spin" /> : <Download />}
                  Baixar resultado
                </Button>
              </div>
              {run.callback_last_error && (
                <p className="error-banner">
                  Falha no envio: {run.callback_last_error}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="chart-header">
              <div>
                <CardTitle>Itens do lote {shortId(run.run_id)}</CardTitle>
                <p>
                  {run.received} itens recebidos · {run.completed} processados
                  {run.failed ? ` · ${run.failed} com falha` : ""}
                </p>
              </div>
              <div
                className="items-view-control"
                role="group"
                aria-label="Visualização dos itens"
              >
                <Button
                  size="sm"
                  variant={view === "board" ? "default" : "outline"}
                  aria-pressed={view === "board"}
                  onClick={() => setView("board")}
                >
                  Quadros
                </Button>
                <Button
                  size="sm"
                  variant={view === "table" ? "default" : "outline"}
                  aria-pressed={view === "table"}
                  onClick={() => setView("table")}
                >
                  Tabela
                </Button>
              </div>
              {view === "table" && (
                <Select value={filter} onValueChange={setFilter}>
                  <SelectTrigger
                    className="item-status-select"
                    aria-label="Filtrar itens"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os itens</SelectItem>
                    <SelectItem value="completed">Processados</SelectItem>
                    <SelectItem value="pending">Pendentes</SelectItem>
                    <SelectItem value="failed">Com falha</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </CardHeader>
            <CardContent>
              {view === "board" ? (
                <ProcessingBoard
                  key={`${run.run_id}:${data.page}`}
                  items={data.items}
                  run={run}
                />
              ) : items.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Duração</TableHead>
                      <TableHead>Tentativas</TableHead>
                      <TableHead>Tempos</TableHead>
                      <TableHead>Preço</TableHead>
                      <TableHead>Estoque</TableHead>
                      {run.failed > 0 && <TableHead>Falha</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.seq}>
                        <TableCell>{item.seq}</TableCell>
                        <TableCell className="sku-cell mono" title={item.sku}>
                          {item.sku}
                        </TableCell>
                        <TableCell>
                          <StatusBadge state={item.state} />
                        </TableCell>
                        <TableCell className="item-duration">
                          {milliseconds(item.processing_duration_ms)}
                          {item.processing_started_at &&
                            !item.processing_finished_at && (
                              <small>até agora</small>
                            )}
                        </TableCell>
                        <TableCell>
                          {item.attempts}
                          {item.state === "pending" && item.attempts > 0 && (
                            <small className="item-next-attempt">
                              Próxima: {dateTime(item.next_attempt_at, true)}
                            </small>
                          )}
                        </TableCell>
                        <TableCell>
                          <details className="item-timing">
                            <summary>Ver tempos</summary>
                            <dl>
                              <dt>Início do processamento</dt>
                              <dd>
                                {item.processing_started_at
                                  ? dateTime(item.processing_started_at, true)
                                  : "Ainda não iniciou"}
                              </dd>
                              <dt>Término do processamento</dt>
                              <dd>
                                {item.processing_finished_at
                                  ? dateTime(item.processing_finished_at, true)
                                  : ["completed", "failed"].includes(item.state)
                                    ? "Horário indisponível"
                                    : "Ainda não terminou"}
                              </dd>
                              <dt>
                                Resposta do{" "}
                                {run.source === "local"
                                  ? "simulador local"
                                  : "backend"}
                              </dt>
                              <dd>
                                {milliseconds(item.backend_duration_ms)}
                                {item.attempts > 1 &&
                                  " · última consulta concluída"}
                              </dd>
                            </dl>
                            {item.attempts > 1 && (
                              <p>
                                {item.attempts} tentativas. A duração inclui a
                                espera entre elas.
                              </p>
                            )}
                            {item.attempt_history.length > 0 && (
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
                                            : "Interrompida"}
                                      {attempt.duration_ms !== null &&
                                        ` · ${milliseconds(attempt.duration_ms)}`}
                                    </span>
                                    <span>
                                      Início:{" "}
                                      {dateTime(attempt.started_at, true)}
                                    </span>
                                    {attempt.finished_at && (
                                      <span>
                                        Término:{" "}
                                        {dateTime(attempt.finished_at, true)}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ol>
                            )}
                            {item.state === "pending" && item.last_error && (
                              <p>{item.last_error}</p>
                            )}
                          </details>
                        </TableCell>
                        <TableCell>{money(item.price)}</TableCell>
                        <TableCell>{item.stock ?? "—"}</TableCell>
                        {run.failed > 0 && (
                          <TableCell className="observation">
                            {item.last_error ?? "—"}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState
                  title={
                    data.items.length
                      ? "Nenhum item neste filtro"
                      : "Aguardando os itens"
                  }
                  description={
                    data.items.length
                      ? "Escolha outro status para consultar os itens."
                      : "Os itens aparecerão conforme forem recebidos."
                  }
                />
              )}
              {data.itemsTotal > 100 && (
                <div className="pagination">
                  <span>
                    Página {data.page + 1} ·{" "}
                    {view === "board" ? "contagens dos quadros" : "filtro"}{" "}
                    referentes aos itens desta página
                  </span>
                  <div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={data.page === 0}
                      onClick={() => setPage(data.page - 1)}
                    >
                      <ArrowLeft />
                      Anterior
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={(data.page + 1) * 100 >= data.itemsTotal}
                      onClick={() => setPage(data.page + 1)}
                    >
                      Próxima
                      <ArrowRight />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <EmptyState
          title="Teste não encontrado"
          description="Volte ao histórico e selecione uma execução."
        />
      )}
    </div>
  );
}
