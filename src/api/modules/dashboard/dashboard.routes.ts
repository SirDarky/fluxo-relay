import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { WebSocket } from "ws";
import { env } from "../../../shared/config/env.js";
import { ApiError } from "../../errors.js";
import { DashboardRepository } from "./dashboard.repository.js";
import { IntegrationRepository } from "../integration/integration.repository.js";
import { IntegrationService } from "../integration/integration.service.js";
import { PlatformClient } from "../integration/platform-client.js";
import { BatchRepository } from "../batches/batch.repository.js";

export async function dashboardRoutes(
  app: FastifyInstance,
  options: {
    pool: Pool;
    telemetryDropped: () => number;
    externalEnabled?: boolean;
    simulationEnabled?: boolean;
    dashboardToken?: string;
  },
) {
  const repository = new DashboardRepository(options.pool);
  const token = options.dashboardToken ?? env.dashboardToken;
  const externalEnabled =
    (options.externalEnabled ?? env.processingEnabled) && !!token;
  const simulationEnabled = options.simulationEnabled ?? env.simulationEnabled;
  const service = new IntegrationService(
    new PlatformClient(env.platformBaseUrl),
    new IntegrationRepository(options.pool),
    new BatchRepository(options.pool),
  );
  const sockets = new Map<
    WebSocket,
    { runId: string | null; page: number; alive: boolean }
  >();
  const tasks = new Set<Promise<void>>();
  const abort = new AbortController();
  let refreshing: Promise<void> | undefined;
  const secureEqual = (candidate: string) =>
    timingSafeEqual(
      createHash("sha256").update(candidate).digest(),
      createHash("sha256").update(token).digest(),
    );

  app.addHook("onRequest", async (request) => {
    const origin = request.headers.origin;
    if (origin) {
      const allowed = (
        process.env.DASHBOARD_ORIGINS ??
        "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4000,http://localhost:4000"
      ).split(",");
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === request.headers.host;
      } catch {
        /* Origem inválida. */
      }
      if (!sameOrigin && !allowed.includes(origin))
        throw new ApiError(
          403,
          "INVALID_ORIGIN",
          "Origem do painel não autorizada.",
        );
    }
    if (request.url === "/dashboard/session") return;
    if (token) {
      const cookie = request.headers.cookie
        ?.split(";")
        .map((value) => value.trim())
        .find((value) => value.startsWith("dashboard_session="))
        ?.slice("dashboard_session=".length);
      const header = request.headers["x-dashboard-token"];
      if (!secureEqual(typeof header === "string" ? header : (cookie ?? "")))
        throw new ApiError(
          401,
          "DASHBOARD_AUTH_REQUIRED",
          "Informe a chave de acesso do painel.",
        );
    }
  });

  app.post("/dashboard/session", async (request, reply) => {
    const header = request.headers["x-dashboard-token"];
    if (!token || typeof header !== "string" || !secureEqual(header))
      throw new ApiError(
        401,
        "DASHBOARD_AUTH_REQUIRED",
        "Chave de acesso inválida.",
      );
    return reply
      .header(
        "set-cookie",
        `dashboard_session=${token}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=28800${request.headers.origin?.startsWith("https:") ? "; Secure" : ""}`,
      )
      .send({ ok: true });
  });

  const querySchema = {
    type: "object",
    properties: {
      run_id: { type: "string", minLength: 1, maxLength: 256 },
      page: { type: "string", pattern: "^\\d{1,6}$" },
    },
  };
  type Query = { run_id?: string; page?: string };
  async function snapshot(runId: string | null, page: number) {
    return {
      ...(await repository.snapshot(runId, page)),
      system: {
        externalEnabled,
        simulationEnabled,
        telemetryDropped: options.telemetryDropped(),
      },
    };
  }
  app.get<{ Querystring: Query }>(
    "/dashboard/snapshot",
    { schema: { querystring: querySchema } },
    async (request) =>
      snapshot(request.query.run_id ?? null, Number(request.query.page ?? 0)),
  );

  app.get<{ Querystring: Query }>(
    "/dashboard/ws",
    { websocket: true, schema: { querystring: querySchema } },
    (socket, request) => {
      if (sockets.size >= 30) {
        socket.close(1013, "Painel ocupado. Tente novamente.");
        return;
      }
      const state = {
        runId: request.query.run_id ?? null,
        page: Number(request.query.page ?? 0),
        alive: true,
      };
      sockets.set(socket, state);
      socket.on("pong", () => {
        state.alive = true;
      });
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
      // Snapshot inicial + snapshots completos na reconexão: nenhuma mudança fica perdida.
      void snapshot(state.runId, state.page)
        .then((data) => {
          if (socket.readyState === 1)
            socket.send(JSON.stringify({ type: "snapshot", data }));
        })
        .catch(() => {
          socket.close(1011, "Falha ao consultar o banco.");
        });
    },
  );
  const timer = setInterval(() => {
    if (refreshing || !sockets.size) return;
    refreshing = (async () => {
      const groups = new Map<
        string,
        { runId: string | null; page: number; sockets: WebSocket[] }
      >();
      for (const [socket, state] of sockets) {
        if (socket.bufferedAmount > 1000000) {
          socket.close(1013, "Cliente lento.");
          continue;
        }
        const key = JSON.stringify([state.runId, state.page]);
        const group = groups.get(key) ?? {
          runId: state.runId,
          page: state.page,
          sockets: [],
        };
        group.sockets.push(socket);
        groups.set(key, group);
      }
      // Clientes com o mesmo filtro compartilham uma consulta.
      for (const group of groups.values()) {
        const message = JSON.stringify({
          type: "snapshot",
          data: await snapshot(group.runId, group.page),
        });
        for (const socket of group.sockets)
          if (socket.readyState === 1) socket.send(message);
      }
    })()
      .catch(() => {
        for (const socket of sockets.keys())
          socket.close(1011, "Falha ao consultar o banco.");
      })
      .finally(() => {
        refreshing = undefined;
      });
  }, 1000);
  const heartbeat = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, 15000);
  timer.unref();
  heartbeat.unref();
  app.addHook("preClose", async () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    abort.abort();
    for (const socket of sockets.keys())
      socket.close(1001, "Servidor reiniciando.");
    await refreshing;
    await Promise.allSettled([...tasks]);
  });

  app.get<{ Params: { runId: string } }>(
    "/dashboard/runs/:runId/report",
    async (request, reply) => {
      const report = await repository.report(request.params.runId);
      if (!report)
        throw new ApiError(
          404,
          "REPORT_NOT_READY",
          "O callback ainda não tem uma resposta confirmada.",
        );
      return reply
        .header(
          "content-disposition",
          'attachment; filename="relatorio-lote.json"',
        )
        .send(report);
    },
  );

  app.post<{ Body: { scenario: "happy" | "resilient" } }>(
    "/dashboard/simulations",
    {
      schema: {
        body: {
          type: "object",
          required: ["scenario"],
          additionalProperties: false,
          properties: {
            scenario: { type: "string", enum: ["happy", "resilient"] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!simulationEnabled)
        throw new ApiError(
          403,
          "SIMULATION_DISABLED",
          "Simulação local desativada.",
        );
      // Evita dois inícios simultâneos no mesmo processo; o limite real é garantido no Redis.
      if (tasks.size)
        throw new ApiError(
          409,
          "SIMULATION_BUSY",
          "Aguarde o envio dos itens da simulação atual.",
        );
      const id = randomUUID().replaceAll("-", "");
      const runId = `local-${id}`;
      await options.pool.query(
        `INSERT INTO integrations (cid,name,webhook,token) VALUES ('local-simulator','Simulador local','http://simulator:4300','local-only') ON CONFLICT (cid) DO NOTHING`,
      );
      await options.pool.query(
        `INSERT INTO runs (run_id,cid,expected_total,started_at,source) VALUES ($1,'local-simulator',20,now(),'local')`,
        [runId],
      );
      const dispatch = (async () => {
        const sequence = [
          8, 2, 15, 0, 19, 5, 11, 1, 17, 3, 9, 6, 14, 4, 18, 7, 12, 10, 16, 13,
        ];
        for (const seq of [...sequence, 2, 8, 15]) {
          if (abort.signal.aborted) break;
          // Passa pela mesma rota e instrumentação da API, sem chamadas externas.
          const response = await app.inject({
            method: "POST",
            url: "/process",
            payload: {
              run_id: runId,
              seq,
              sku: `demo-${id}-${request.body.scenario}-${seq}`,
            },
          });
          if (response.statusCode !== 202)
            throw new Error("Falha no recebimento da simulação local.");
          await delay(100, undefined, { signal: abort.signal });
        }
      })().catch((error: Error) => {
        if (!abort.signal.aborted)
          app.log.error({ message: error.message }, "Falha na simulação");
      });
      tasks.add(dispatch);
      void dispatch.finally(() => tasks.delete(dispatch));
      return reply
        .code(202)
        .send({ run_id: runId, total: 20, source: "local" });
    },
  );

  const requireExternal = () => {
    if (!externalEnabled)
      throw new ApiError(
        403,
        "EXTERNAL_DISABLED",
        "Chamadas à plataforma estão desativadas. Configure a autorização e a chave do painel antes de usar o modo real.",
      );
  };
  app.post<{ Body: { name: string; webhook: string } }>(
    "/dashboard/integration",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "webhook"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            webhook: { type: "string", minLength: 1, maxLength: 2048 },
          },
        },
      },
    },
    async (request) => {
      requireExternal();
      return service.register(request.body.name, request.body.webhook);
    },
  );
  app.post<{ Body: { cid: string } }>(
    "/dashboard/bursts",
    {
      schema: {
        body: {
          type: "object",
          required: ["cid"],
          additionalProperties: false,
          properties: { cid: { type: "string", minLength: 1, maxLength: 256 } },
        },
      },
    },
    async (request) => {
      requireExternal();
      if (request.body.cid === "local-simulator")
        throw new ApiError(
          400,
          "INVALID_INTEGRATION",
          "Selecione uma integração real.",
        );
      return service.requestBatch(request.body.cid);
    },
  );
}
