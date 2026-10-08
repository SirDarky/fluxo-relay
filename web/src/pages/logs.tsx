import { useState } from "react";
import { Download, Pause, Play, Search, Terminal, Filter } from "lucide-react";
import type {
  DashboardSnapshot,
  DashboardEvent,
} from "../../../src/shared/contracts/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/empty-state";
import { downloadJson } from "@/lib/api";
import { date, shortId, time } from "@/lib/format";

const levels = {
  info: "INFO",
  success: "SUCESSO",
  warning: "AVISO",
  error: "ERRO",
};
export function Logs({ data }: { data: DashboardSnapshot }) {
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("all");
  const [paused, setPaused] = useState<DashboardEvent[] | null>(null);
  const events = (paused ?? data.events).filter(
    (event) =>
      (level === "all" || event.level === level) &&
      `${event.run_id} ${event.message} ${event.seq ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <Card className="logs-card">
      <CardHeader className="chart-header">
        <div>
          <CardTitle>
            <Terminal size={18} />
            Eventos do processamento
          </CardTitle>
          <p>O que aconteceu em cada teste.</p>
        </div>
        <div className="button-row">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused(paused ? null : [...data.events])}
          >
            {paused ? <Play /> : <Pause />}
            {paused ? "Retomar" : "Pausar visualização"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!events.length}
            onClick={() => downloadJson(events, "logs-processamento.json")}
          >
            <Download />
            Exportar
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="logs-toolbar">
          <div className="search-field">
            <Search size={16} />
            <Input
              placeholder="Buscar mensagem, lote ou posição…"
              aria-label="Buscar nos logs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger className="level-select">
              <Filter size={14} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os níveis</SelectItem>
              {Object.entries(levels).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className={`live-label ${paused ? "paused" : ""}`}>
            <i />
            {paused ? "Visualização pausada" : "Atualizando ao vivo"}
          </span>
        </div>
        <div className="log-console">
          {events.length ? (
            events.map((event) => (
              <div className="log-row" key={event.id}>
                <time title={date(event.created_at)}>
                  {time(event.created_at)}
                </time>
                <span className={`log-level ${event.level}`}>
                  {levels[event.level]}
                </span>
                <div>
                  <p>{event.message}</p>
                  <span className="mono">
                    {data.runs.find((run) => run.run_id === event.run_id)
                      ?.test_number
                      ? `Teste ${data.runs.find((run) => run.run_id === event.run_id)!.test_number}`
                      : shortId(event.run_id)}
                    {event.seq !== null ? ` / item ${event.seq}` : " / lote"}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <EmptyState
              title="Nenhum evento encontrado"
              description="Inicie um lote ou ajuste os filtros para consultar os registros."
            />
          )}
        </div>
        <div className="logs-footer">
          <span>{events.length} eventos exibidos</span>
          <span>Atualizado às {time(data.generatedAt)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
