import { useState, type FormEvent } from "react";
import {
  Cable,
  ExternalLink,
  Globe,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Play,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import type { DashboardSnapshot } from "../../../src/shared/contracts/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";

export function Integration({
  data,
  onBatch,
}: {
  data: DashboardSnapshot;
  onBatch: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [webhook, setWebhook] = useState("");
  const [cid, setCid] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const selected = cid || data.integrations[0]?.cid || "";
  async function register(event: FormEvent) {
    event.preventDefault();
    setBusy("register");
    try {
      const response = await api<{ cid: string }>("/integration", {
        method: "POST",
        body: JSON.stringify({ name, webhook }),
      });
      setCid(response.cid);
      toast.success("Integração cadastrada.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha no cadastro.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function start() {
    setBusy("burst");
    try {
      const response = await api<{ run_id: string }>("/bursts", {
        method: "POST",
        body: JSON.stringify({ cid: selected }),
      });
      onBatch(response.run_id);
      toast.success("Lote solicitado. Aguardando os itens.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao iniciar.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="page-stack">
      <div
        className={`mode-banner ${data.system.externalEnabled ? "enabled" : ""}`}
      >
        <div className="mode-banner-icon">
          <LockKeyhole size={22} />
        </div>
        <div>
          <strong>
            {data.system.externalEnabled
              ? "Modo real disponível"
              : "Chamadas à plataforma desativadas"}
          </strong>
          <p>
            {data.system.externalEnabled
              ? "Os controles abaixo chamam o backend da plataforma. Cada início cria uma nova execução."
              : "Você pode usar a simulação local. Cadastro e início de lote real ficam bloqueados no backend enquanto o modo externo estiver desligado."}
          </p>
        </div>
        <span className="source-pill">
          {data.system.externalEnabled ? "Real" : "Modo local"}
        </span>
      </div>
      <div className="integration-grid">
        <Card>
          <CardHeader>
            <div className="section-icon">
              <Cable size={20} />
            </div>
            <CardTitle>1. Conectar a plataforma</CardTitle>
            <p>Cadastre o endereço público da nossa API.</p>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => {
                void register(event);
              }}
              className="form-stack"
            >
              <div>
                <Label htmlFor="name">Nome da integração</Label>
                <Input
                  id="name"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Fluxo Relay"
                  disabled={!data.system.externalEnabled}
                />
              </div>
              <div>
                <Label htmlFor="webhook">URL pública da API</Label>
                <Input
                  id="webhook"
                  type="url"
                  required
                  value={webhook}
                  onChange={(event) => setWebhook(event.target.value)}
                  placeholder="https://seu-endereco.ngrok-free.app"
                  disabled={!data.system.externalEnabled}
                />
                <small>
                  Informe a URL base. Eles vão chamar /check e /process.
                </small>
              </div>
              <Button
                type="submit"
                disabled={!data.system.externalEnabled || busy !== null}
              >
                {busy === "register" ? (
                  <LoaderCircle className="spin" />
                ) : (
                  <Globe />
                )}
                Cadastrar integração
              </Button>
              <p className="form-note">
                <KeyRound size={14} />O token da plataforma fica apenas no
                backend.
              </p>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="section-icon">
              <Play size={20} />
            </div>
            <CardTitle>2. Iniciar um lote real</CardTitle>
            <p>A plataforma envia os 20 itens separadamente.</p>
          </CardHeader>
          <CardContent>
            <div className="form-stack">
              <div>
                <Label>Integração cadastrada</Label>
                <Select
                  value={selected}
                  onValueChange={setCid}
                  disabled={
                    !data.system.externalEnabled || !data.integrations.length
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Nenhuma integração cadastrada" />
                  </SelectTrigger>
                  <SelectContent>
                    {data.integrations.map((item) => (
                      <SelectItem value={item.cid} key={item.cid}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                disabled={
                  !data.system.externalEnabled || !selected || busy !== null
                }
                onClick={() => {
                  void start();
                }}
              >
                {busy === "burst" ? (
                  <LoaderCircle className="spin" />
                ) : (
                  <Play />
                )}
                Iniciar lote real
              </Button>
              <small>
                Cada clique solicita um lote novo. Não repetimos essa chamada
                automaticamente.
              </small>
            </div>
          </CardContent>
        </Card>
      </div>
      <details className="integration-help">
        <summary>Como habilitar o teste real</summary>
        <Card>
          <CardHeader>
            <CardTitle>
              <ShieldCheck size={18} />
              Como habilitar o teste real depois
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="setup-list">
              <li>
                <span>01</span>
                <div>
                  <strong>Expor a API com ngrok</strong>
                  <p>
                    Aponte o túnel para o gateway na porta 4100. O endereço
                    HTTPS alcança /check e /process; o painel continua local.
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Configurar o ambiente</strong>
                  <p>
                    Após liberar o teste real, configure PROCESSING_ENABLED=true
                    e uma DASHBOARD_TOKEN hexadecimal de pelo menos 32
                    caracteres. Reinicie API e worker.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Cadastrar e iniciar</strong>
                  <p>
                    Use os controles acima e acompanhe o resultado nas abas
                    Testes e Logs.
                  </p>
                </div>
              </li>
            </ol>
            <a
              className="text-link"
              href="https://ngrok.com/docs/getting-started"
              target="_blank"
              rel="noreferrer"
            >
              Documentação do ngrok
              <ExternalLink size={13} />
            </a>
          </CardContent>
        </Card>
      </details>
    </div>
  );
}
