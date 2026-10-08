import { lazy, Suspense, useState, type FormEvent } from "react";
import {
  ArrowRight,
  KeyRound,
  LoaderCircle,
  Play,
  Radio,
  Workflow,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDashboard } from "@/hooks/use-dashboard";
import { api } from "@/lib/api";
const Overview = lazy(() =>
  import("@/pages/overview").then((module) => ({ default: module.Overview })),
);
const Batches = lazy(() =>
  import("@/pages/batches").then((module) => ({ default: module.Batches })),
);
const Logs = lazy(() =>
  import("@/pages/logs").then((module) => ({ default: module.Logs })),
);
const Integration = lazy(() =>
  import("@/pages/integration").then((module) => ({
    default: module.Integration,
  })),
);

export default function App() {
  const params = new URLSearchParams(location.search);
  const [tab, setTab] = useState(
    ["logs", "integration"].includes(params.get("tab") ?? "")
      ? params.get("tab")!
      : "overview",
  );
  const [runId, setRunId] = useState<string | null>(params.get("run"));
  const [page, setPage] = useState(0);
  const [session, setSession] = useState(0);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [simulation, setSimulation] = useState(false);
  const [scenario, setScenario] = useState<"happy" | "resilient">("happy");
  const {
    snapshot: data,
    connection,
    error,
    authRequired,
  } = useDashboard(runId, page, session);
  function navigate(next: string, nextRun = runId) {
    setTab(next);
    const query = new URLSearchParams({ tab: next });
    if (nextRun) query.set("run", nextRun);
    history.replaceState(null, "", `${location.pathname}?${query}`);
  }
  function selectRun(id: string | null) {
    setRunId(id);
    setPage(0);
    navigate("overview", id);
  }
  async function startSimulation() {
    setBusy(true);
    try {
      const result = await api<{ run_id: string }>("/simulations", {
        method: "POST",
        body: JSON.stringify({ scenario }),
      });
      selectRun(result.run_id);
      setSimulation(false);
      toast.success("Teste iniciado.");
    } catch (failure) {
      toast.error(
        failure instanceof Error ? failure.message : "Falha ao iniciar.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/session", {
        method: "POST",
        headers: { "x-dashboard-token": key },
      });
      setKey("");
      setSession((value) => value + 1);
    } catch (failure) {
      toast.error(
        failure instanceof Error ? failure.message : "Chave inválida.",
      );
    } finally {
      setBusy(false);
    }
  }
  const selectedTest = data?.runs.find((run) => run.run_id === runId);
  const matchingScope = data?.selectedRunId === runId && data?.page === page;
  return (
    <div className="simple-shell">
      <header className="simple-topbar">
        <a href="/" className="simple-brand" aria-label="Fluxo Relay">
          <Workflow size={23} />
          fluxo relay.
        </a>
        <div>
          <span className="simple-mode">
            {data?.system.externalEnabled
              ? "Modo real disponível"
              : "Ambiente local"}
          </span>
          <span className={`connection-chip ${connection}`}>
            <Radio size={13} />
            {connection === "live" ? "Ao vivo" : "Conectando"}
          </span>
        </div>
      </header>
      <main className="simple-content">
        <div className="page-heading">
          <div>
            <h1>Testes de processamento</h1>
            <p>Início, término e resultado de cada execução.</p>
          </div>
          <Button
            onClick={() => setSimulation(true)}
            disabled={!data?.system.simulationEnabled || busy}
          >
            <Play size={15} />
            Novo teste
          </Button>
        </div>
        {authRequired ? (
          <div className="access-card">
            <KeyRound size={30} />
            <h2>Acesse seu painel</h2>
            <form
              className="form-stack"
              onSubmit={(event) => {
                void login(event);
              }}
            >
              <Label htmlFor="access">Chave de acesso</Label>
              <Input
                id="access"
                type="password"
                autoComplete="off"
                required
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
              <Button disabled={busy}>
                {busy ? <LoaderCircle className="spin" /> : <ArrowRight />}
                Entrar
              </Button>
            </form>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => navigate(value)}>
            <div className="tabs-bar">
              <TabsList variant="line">
                <TabsTrigger value="overview">Testes</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
                <TabsTrigger value="integration">Integração</TabsTrigger>
              </TabsList>
              {tab === "logs" && (
                <Select
                  value={runId ?? "all"}
                  onValueChange={(value) => {
                    const id = value === "all" ? null : value;
                    setRunId(id);
                    setPage(0);
                    navigate("logs", id);
                  }}
                >
                  <SelectTrigger
                    className="run-select"
                    aria-label="Filtrar teste"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os testes</SelectItem>
                    {data?.runs.map((run) => (
                      <SelectItem key={run.run_id} value={run.run_id}>
                        Teste {run.test_number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {tab === "overview" && runId && selectedTest && (
                <span className="selected-test-label">
                  Teste {selectedTest.test_number}
                </span>
              )}
            </div>
            {error && <div className="error-banner">{error}</div>}
            {data ? (
              <Suspense
                fallback={
                  <div className="loading-state">
                    <LoaderCircle className="spin" />
                    <p>Carregando…</p>
                  </div>
                }
              >
                <TabsContent value="overview">
                  {runId ? (
                    matchingScope ? (
                      <Batches
                        key={runId}
                        data={data}
                        selectRun={selectRun}
                        setPage={setPage}
                        openLogs={() => navigate("logs")}
                      />
                    ) : (
                      <div className="loading-state">
                        <LoaderCircle className="spin" />
                        <p>Carregando teste…</p>
                      </div>
                    )
                  ) : (
                    <Overview data={data} selectRun={selectRun} />
                  )}
                </TabsContent>
                <TabsContent value="logs">
                  <Logs key={runId ?? "all"} data={data} />
                </TabsContent>
                <TabsContent value="integration">
                  <Integration data={data} onBatch={selectRun} />
                </TabsContent>
              </Suspense>
            ) : (
              <div className="loading-state">
                <LoaderCircle className="spin" />
                <p>Conectando…</p>
              </div>
            )}
          </Tabs>
        )}
      </main>
      <Dialog open={simulation} onOpenChange={setSimulation}>
        <DialogContent className="simulation-dialog">
          <DialogHeader>
            <DialogTitle>Novo teste local</DialogTitle>
            <DialogDescription>
              Um lote com 20 itens. Nenhuma chamada à plataforma externa.
            </DialogDescription>
          </DialogHeader>
          <Label>Cenário</Label>
          <Select
            value={scenario}
            onValueChange={(value) => setScenario(value as typeof scenario)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="happy">Todos os itens passam</SelectItem>
              <SelectItem value="resilient">
                Com falhas temporárias e novas tentativas
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            disabled={busy}
            onClick={() => {
              void startSimulation();
            }}
          >
            {busy ? <LoaderCircle className="spin" /> : <Play />}Iniciar teste
          </Button>
        </DialogContent>
      </Dialog>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
