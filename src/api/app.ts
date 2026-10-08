import Fastify, { type FastifyError } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { database, createDatabasePool } from "../shared/infra/database.js";
import { redis } from "../shared/infra/redis.js";
import { env } from "../shared/config/env.js";
import { healthRoutes } from "./routes/health.routes.js";
import { checkRoute } from "./modules/integration/check.route.js";
import { processRoute } from "./modules/processing/process.route.js";
import { ItemRepository } from "./modules/processing/item.repository.js";
import { ApiError } from "./errors.js";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { recordAcknowledgements } from "./modules/dashboard/ack-recorder.js";

export function buildApp(
  options: {
    pool?: Pool;
    dashboardPool?: Pool;
    redis?: Redis;
    logger?: boolean;
    dashboard?: {
      externalEnabled?: boolean;
      simulationEnabled?: boolean;
      dashboardToken?: string;
    };
  } = {},
) {
  const pool = options.pool ?? database;
  // As consultas dos gráficos têm seu próprio pool, preservando as conexões do ACK.
  const dashboardPool =
    options.dashboardPool ?? (options.pool ? pool : createDatabasePool(3));
  const redisConnection = options.redis ?? redis;
  const app = Fastify({
    bodyLimit: 32768,
    ajv: { customOptions: { coerceTypes: false } },
    logger:
      options.logger === false
        ? false
        : {
            level: env.logLevel,
            redact: [
              "req.headers.authorization",
              "req.headers.x-token",
              "req.headers.x-dashboard-token",
              "req.headers.cookie",
            ],
          },
  });
  const acknowledgements = recordAcknowledgements(app, dashboardPool);
  app.register(websocket, { options: { maxPayload: 1024 } });
  app.register(dashboardRoutes, {
    pool: dashboardPool,
    telemetryDropped: acknowledgements.dropped,
    ...options.dashboard,
  });
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (existsSync(webRoot))
    app.register(fastifyStatic, { root: webRoot, prefix: "/" });

  const databaseError = (error: Error) =>
    app.log.error({ err: error }, "Falha no PostgreSQL");
  const redisError = (error: Error) =>
    app.log.error({ err: error }, "Falha no Redis");
  pool.on("error", databaseError);
  if (dashboardPool !== pool) dashboardPool.on("error", databaseError);
  redisConnection.on("error", redisError);

  app.register(healthRoutes, { pool, redis: redisConnection });
  app.register(checkRoute);
  app.register(processRoute, { repository: new ItemRepository(pool) });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (
      error.validation ||
      (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
    ) {
      if (!(error instanceof ApiError)) {
        return reply
          .code(error.statusCode ?? 400)
          .send({
            error: "INVALID_REQUEST",
            message: "Confira o JSON e os campos enviados.",
          });
      }
    }
    if (error instanceof ApiError) {
      if (error.statusCode >= 500)
        request.log.error({ err: error }, "Falha no recebimento");
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message });
    }
    request.log.error({ err: error }, "Erro interno");
    return reply
      .code(500)
      .send({ error: "INTERNAL_ERROR", message: "Ocorreu um erro interno." });
  });

  app.addHook("onClose", async () => {
    pool.off("error", databaseError);
    redisConnection.off("error", redisError);
    await acknowledgements.close();
    if (dashboardPool !== pool) {
      dashboardPool.off("error", databaseError);
      await dashboardPool.end();
    }
    redisConnection.disconnect();
    await pool.end();
  });

  return app;
}
