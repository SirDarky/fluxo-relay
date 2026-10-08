import { ArrowRight } from "lucide-react";
import type { DashboardSnapshot } from "../../../src/shared/contracts/dashboard";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { TestSummary } from "@/components/test-summary";

export function Overview({
  data,
  selectRun,
}: {
  data: DashboardSnapshot;
  selectRun: (id: string) => void;
}) {
  if (!data.runs.length)
    return (
      <Card>
        <EmptyState
          title="Seu primeiro teste começa aqui"
          description="Clique em Novo teste para acompanhar o processamento de um lote."
        />
      </Card>
    );
  return (
    <div className="test-history">
      {data.runs.map((run) => (
        <Card className="test-card" key={run.run_id}>
          <CardContent>
            <TestSummary run={run} now={data.generatedAt} />
            <div className="test-card-actions">
              <Button variant="outline" onClick={() => selectRun(run.run_id)}>
                Ver itens e resultado
                <ArrowRight size={15} />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
