import type { DashboardRun } from "../../../src/shared/contracts/dashboard";
import { Progress } from "@/components/ui/progress";
import { StatusBadge, runState } from "@/components/status-badge";
import { dateTime, duration, shortId } from "@/lib/format";

export function TestSummary({ run, now }: { run: DashboardRun; now: string }) {
  const start = run.started_at ?? run.created_at;
  const elapsed =
    run.duration_ms ?? new Date(now).getTime() - new Date(start).getTime();
  const waiting = Math.max(
    0,
    (run.expected_total ?? run.received) - run.completed - run.failed,
  );
  return (
    <>
      <div className="test-card-heading">
        <div>
          <h2>Teste {run.test_number}</h2>
          <span>
            {run.source === "local" ? "Simulação local" : "Plataforma real"}
          </span>
        </div>
        <StatusBadge state={runState(run)} />
      </div>
      <dl className="test-timing">
        <div>
          <dt>Início</dt>
          <dd>{dateTime(start)}</dd>
        </div>
        <div>
          <dt>Término</dt>
          <dd>
            {run.finished_at ? dateTime(run.finished_at) : "Ainda não terminou"}
          </dd>
        </div>
        <div>
          <dt>Duração{run.finished_at ? "" : " até agora"}</dt>
          <dd>{duration(elapsed)}</dd>
        </div>
      </dl>
      <div className="test-progress-label">
        <strong>
          {run.completed} de {run.expected_total ?? "?"} itens processados
        </strong>
        <span>
          {run.failed
            ? `${run.failed} com falha`
            : waiting
              ? `${waiting} aguardando`
              : run.delivery_state === "delivered"
                ? "Resultado enviado"
                : "Aguardando envio do resultado"}
        </span>
      </div>
      <Progress
        value={
          run.expected_total
            ? Math.min(
                100,
                ((run.completed + run.failed) / run.expected_total) * 100,
              )
            : 0
        }
        className={run.failed ? "failed-progress" : ""}
      />
      <div className="test-batch-label">
        <span>Lote</span>
        <code title={run.run_id}>{shortId(run.run_id)}</code>
      </div>
    </>
  );
}
