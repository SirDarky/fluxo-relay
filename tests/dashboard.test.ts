import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import pg from "pg";
import { buildApp } from "../src/api/app.js";
import { database } from "../src/shared/infra/database.js";
import { redis, createRedis } from "../src/shared/infra/redis.js";
import { env } from "../src/shared/config/env.js";
import { migrate } from "../src/shared/infra/migrate.js";
import { WorkRepository } from "../src/worker/repositories/work.repository.js";
import { DeliveryRepository } from "../src/worker/repositories/delivery.repository.js";

test("Painel com banco isolado e nenhuma chamada à plataforma", async (t) => {
  const schema = `dashboard_test_${randomUUID().replaceAll("-", "")}`;
  await database.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({
    connectionString: env.databaseUrl,
    options: `-c search_path=${schema}`,
    max: 8,
  });
  await migrate(pool);
  const token = "a".repeat(32);
  const app = buildApp({
    pool,
    redis: createRedis("request"),
    logger: false,
    dashboard: { dashboardToken: token, externalEnabled: false },
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.end();
    redis.disconnect();
  });
  const headers = { "x-dashboard-token": token };
  const request = (url: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url,
      headers,
      payload: payload as Record<string, unknown>,
    });

  await t.test(
    "HTTP e WebSocket exigem acesso e recusam origem de outro site",
    async () => {
      assert.equal((await app.inject("/dashboard/snapshot")).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            url: "/dashboard/snapshot",
            headers: { ...headers, origin: "https://untrusted.invalid" },
          })
        ).statusCode,
        403,
      );
      await assert.rejects(app.injectWS("/dashboard/ws"));
      await assert.rejects(
        app.injectWS("/dashboard/ws", {
          headers: { ...headers, origin: "https://untrusted.invalid" },
        }),
      );
      const login = await app.inject({
        method: "POST",
        url: "/dashboard/session",
        headers,
      });
      assert.equal(login.statusCode, 200);
      assert.match(
        String(login.headers["set-cookie"]),
        /HttpOnly; SameSite=Strict/,
      );
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      assert.equal(
        (await app.inject({ url: "/dashboard/snapshot", headers: { cookie } }))
          .statusCode,
        200,
      );
    },
  );

  await t.test(
    "controles reais ficam bloqueados antes de qualquer requisição externa",
    async () => {
      assert.equal(
        (
          await request("/dashboard/integration", {
            name: "Teste",
            webhook: "https://simulado.invalid",
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await request("/dashboard/bursts", { cid: "unknown" })).statusCode,
        403,
      );
      assert.equal(
        (await request("/dashboard/simulations", { scenario: "invalid" }))
          .statusCode,
        400,
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM integrations"))
          .rows[0].count,
        0,
      );
    },
  );

  await pool.query(
    `INSERT INTO integrations(cid,name,webhook,token) VALUES ('real-cid','Teste','https://example.invalid','never-expose-this-token')`,
  );
  await pool.query(
    `INSERT INTO runs(run_id,cid,expected_total) VALUES ('observed-run','real-cid',2)`,
  );
  const post = (seq: number) =>
    app.inject({
      method: "POST",
      url: "/process",
      payload: { run_id: "observed-run", seq, sku: `sku-${seq}` },
    });

  await t.test(
    "WebSocket transmite recebimento, duplicata e conclusão com snapshot na reconexão",
    async () => {
      const socket = await app.injectWS("/dashboard/ws?run_id=observed-run", {
        headers,
      });
      const first = once(socket, "message");
      const initial = JSON.parse((await first)[0].toString());
      assert.equal(initial.data.metrics.received, 0);
      await app.inject({ method: 'POST', url: '/process', payload: {
        run_id: 'observed-run', seq: 0, sku: 'sku-0', token: 'received-secret-extra',
      } });
      await post(1);
      await post(0);
      const next = once(socket, "message");
      const updated = JSON.parse((await next)[0].toString());
      assert.equal(updated.data.metrics.received, 2);
      assert.equal(updated.data.metrics.duplicates, 1);
      assert.deepEqual(updated.data.items[0].received_payload, { run_id: 'observed-run', seq: 0, sku: 'sku-0' });
      assert.equal(JSON.stringify(updated).includes('received-secret-extra'), false);
      assert.ok(new Date(updated.data.items[0].last_received_at) >= new Date(updated.data.items[0].received_at));
      assert.ok(
        updated.data.events.some(
          (event: { kind: string }) => event.kind === "duplicate",
        ),
      );
      socket.terminate();
      await pool.query(
        `UPDATE items SET state='completed',price=10,stock=5,processed_at=now() WHERE run_id='observed-run'`,
      );
      const reconnected = await app.injectWS(
        "/dashboard/ws?run_id=observed-run",
        { headers },
      );
      const resumed = JSON.parse(
        (await once(reconnected, "message"))[0].toString(),
      );
      assert.equal(resumed.data.metrics.completed, 2);
      reconnected.terminate();
    },
  );

  await t.test(
    "KPIs e logs vêm do banco, sem tokens, com warmup excluído e filtros validados",
    async () => {
      await delay(600);
      const response = await app.inject({
        url: "/dashboard/snapshot?run_id=observed-run",
        headers,
      });
      assert.equal(response.statusCode, 200);
      const data = response.json();
      assert.equal(data.metrics.ack_count, 2);
      assert.equal(data.metrics.completed, 2);
      assert.equal(data.metrics.duplicates, 1);
      assert.equal(data.timeline.length, 15);
      assert.equal(
        data.latency.reduce(
          (sum: number, bin: { count: number }) => sum + bin.count,
          0,
        ),
        2,
      );
      assert.equal(response.body.includes("never-expose-this-token"), false);
      assert.equal(
        (await app.inject({ url: "/dashboard/snapshot?page=-1", headers }))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            url: "/dashboard/snapshot?run_id=missing",
            headers,
          })
        ).json().items.length,
        0,
      );
      assert.equal(
        (
          await app.inject({
            url: "/dashboard/runs/observed-run/report",
            headers,
          })
        ).statusCode,
        404,
      );
    },
  );

  await t.test(
    "lotes locais ficam fora da seleção e do processador de lotes reais",
    async () => {
      await pool.query(
        `INSERT INTO runs (run_id,cid,expected_total,source) VALUES ('local-isolated','real-cid',1,'local')`,
      );
      await app.inject({
        method: "POST",
        url: "/process",
        payload: { run_id: "local-isolated", seq: 0, sku: "local-sku" },
      });
      const remote = new WorkRepository(pool);
      const local = new WorkRepository(pool, "local");
      assert.equal(
        (await remote.candidates(1, 1)).some(
          (job) => job.run_id === "local-isolated",
        ),
        false,
      );
      assert.equal(
        (await local.candidates(1, 1)).some(
          (job) => job.run_id === "local-isolated",
        ),
        true,
      );
      const client = await pool.connect();
      try {
        assert.equal(
          await remote.context(client, { run_id: "local-isolated", seq: 0 }),
          undefined,
        );
        assert.equal(
          (await local.context(client, { run_id: "local-isolated", seq: 0 }))
            ?.sku,
          "local-sku",
        );
      } finally {
        client.release();
      }
      await pool.query(
        `UPDATE items SET state='completed',price=1,stock=1 WHERE run_id='local-isolated'`,
      );
      assert.equal(
        (await new DeliveryRepository(pool).candidates(1)).some(
          (run) => run.run_id === "local-isolated",
        ),
        false,
      );
      assert.equal(
        (await new DeliveryRepository(pool, "local").candidates(1)).some(
          (run) => run.run_id === "local-isolated",
        ),
        true,
      );
    },
  );

  await t.test(
    "teste tem número fixo, início e término confirmado, sem numerar mensagens avulsas",
    async () => {
      await app.inject({
        method: "POST",
        url: "/process",
        payload: { run_id: "untracked-message", seq: 0, sku: "loose-sku" },
      });
      assert.equal(
        (
          await pool.query(
            "SELECT test_number FROM runs WHERE run_id='untracked-message'",
          )
        ).rows[0].test_number,
        null,
      );
      const first = (
        await app.inject({
          url: "/dashboard/snapshot?run_id=observed-run",
          headers,
        })
      ).json();
      const run = first.runs.find(
        (item: { run_id: string }) => item.run_id === "observed-run",
      );
      assert.equal(run.test_number, 1);
      assert.equal(
        run.finished_at,
        null,
        "Itens prontos ainda aguardam callback.",
      );
      await pool.query(
        "UPDATE runs SET delivery_state='delivered',delivered_at=now() WHERE run_id='observed-run'",
      );
      const next = (
        await app.inject({
          url: "/dashboard/snapshot?run_id=observed-run",
          headers,
        })
      )
        .json()
        .runs.find(
          (item: { run_id: string }) => item.run_id === "observed-run",
        );
      assert.equal(next.test_number, 1);
      assert.equal(next.finished_at, next.delivered_at);
      assert.ok(next.duration_ms >= 0);
      assert.equal(await migrate(pool).then((names) => names.length), 0);
    },
  );

  await t.test(
    "término com falha aguarda todos os itens e resiste a duas conclusões simultâneas",
    async () => {
      await pool.query(
        "INSERT INTO runs(run_id,cid,expected_total,started_at) VALUES ('terminal-race','real-cid',2,now())",
      );
      for (const seq of [0, 1])
        await app.inject({
          method: "POST",
          url: "/process",
          payload: { run_id: "terminal-race", seq, sku: `terminal-${seq}` },
        });
      await Promise.all([
        pool.query(
          "UPDATE items SET state='failed',last_error='Falha local.' WHERE run_id='terminal-race' AND seq=0",
        ),
        pool.query(
          "UPDATE items SET state='completed',price=1,stock=1,processed_at=now() WHERE run_id='terminal-race' AND seq=1",
        ),
      ]);
      assert.ok(
        (
          await pool.query(
            "SELECT finished_at FROM runs WHERE run_id='terminal-race'",
          )
        ).rows[0].finished_at,
      );
      await pool.query(
        "INSERT INTO runs(run_id,cid,expected_total) VALUES ('callback-failed','real-cid',1)",
      );
      await pool.query(
        "UPDATE runs SET delivery_state='failed' WHERE run_id='callback-failed'",
      );
      assert.ok(
        (
          await pool.query(
            "SELECT finished_at FROM runs WHERE run_id='callback-failed'",
          )
        ).rows[0].finished_at,
      );
    },
  );

  await t.test(
    "tempos por item distinguem fila, novas tentativas, resposta HTTP e falha final",
    async () => {
      await pool.query(
        "INSERT INTO runs(run_id,cid,expected_total,source) VALUES ('item-timing','real-cid',4,'local')",
      );
      await pool.query(`INSERT INTO items(run_id,seq,sku) VALUES
        ('item-timing',0,'queued'),('item-timing',1,'retried'),
        ('item-timing',2,'in-progress'),('item-timing',3,'failed')`);
      await pool.query(`INSERT INTO product_attempts(run_id,seq,attempt,started_at,finished_at,duration_ms,http_status) VALUES
        ('item-timing',1,1,'2026-10-06T12:00:00Z','2026-10-06T12:00:00.100Z',100,500),
        ('item-timing',1,2,'2026-10-06T12:00:01Z','2026-10-06T12:00:01.400Z',400,200),
        ('item-timing',3,1,'2026-10-06T12:00:00Z','2026-10-06T12:00:00.200Z',200,500)`);
      await pool.query(`INSERT INTO product_attempts(run_id,seq,attempt,started_at)
        VALUES ('item-timing',2,1,now()-interval '1 second')`);
      await pool.query(`UPDATE items SET state='completed',attempts=2,
        received_at='2026-10-06T11:59:00Z',processed_at='2026-10-06T12:00:01.450Z'
        WHERE run_id='item-timing' AND seq=1`);
      await pool.query(`UPDATE items SET state='processing',attempts=1 WHERE run_id='item-timing' AND seq=2`);
      await pool.query(`UPDATE items SET state='failed',attempts=1,last_error='Falha definitiva local.'
        WHERE run_id='item-timing' AND seq=3`);
      // Horário determinístico do encerramento, inclusive sem processed_at em falhas.
      await pool.query(`UPDATE processing_events SET created_at='2026-10-06T12:00:00.250Z'
        WHERE run_id='item-timing' AND seq=3 AND kind='failed'`);
      const read = async () => (
        await app.inject({ url: '/dashboard/snapshot?run_id=item-timing', headers })
      ).json().items;
      const [queued, retried, active, failed] = await read();
      assert.equal(queued.processing_started_at, null);
      assert.equal(queued.processing_finished_at, null);
      assert.equal(queued.processing_duration_ms, null);
      assert.equal(queued.backend_duration_ms, null);
      assert.deepEqual(queued.attempt_history, []);
      assert.equal(retried.processing_started_at, '2026-10-06T12:00:00.000Z');
      assert.equal(retried.processing_finished_at, '2026-10-06T12:00:01.450Z');
      assert.equal(retried.processing_duration_ms, 1450, 'Inclui espera entre tentativas, exclui fila inicial.');
      assert.equal(retried.backend_duration_ms, 400, 'Mostra a última consulta, não a soma das tentativas.');
      assert.deepEqual(retried.attempt_history.map((entry: { attempt: number; http_status: number; duration_ms: number }) =>
        [entry.attempt,entry.http_status,entry.duration_ms]), [[1,500,100],[2,200,400]]);
      assert.equal(active.processing_finished_at, null);
      assert.ok(active.processing_duration_ms >= 1000);
      assert.equal(active.backend_duration_ms, null);
      assert.equal(failed.processing_finished_at, '2026-10-06T12:00:00.250Z');
      assert.equal(failed.processing_duration_ms, 250);
      assert.equal(failed.backend_duration_ms, 200);
      await delay(30);
      const next = await read();
      assert.ok(next[2].processing_duration_ms > active.processing_duration_ms);
      assert.equal(next[1].processing_duration_ms, retried.processing_duration_ms);
      assert.equal(next[3].processing_duration_ms, failed.processing_duration_ms);
    },
  );

  await t.test(
    "simulador entrega 20 itens e três duplicatas pela rota original, sem token exposto",
    async () => {
      const response = await request("/dashboard/simulations", {
        scenario: "resilient",
      });
      assert.equal(response.statusCode, 202);
      const run = response.json();
      // Espera uma condição de domínio, sem presumir a velocidade do computador.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const count = await pool.query(
          "SELECT COALESCE(sum(deliveries-1),0)::int AS duplicates FROM items WHERE run_id=$1",
          [run.run_id],
        );
        if (count.rows[0].duplicates === 3) break;
        await delay(50);
      }
      const snapshot = (
        await app.inject({
          url: `/dashboard/snapshot?run_id=${run.run_id}`,
          headers,
        })
      ).json();
      assert.equal(snapshot.metrics.received, 20);
      assert.equal(snapshot.metrics.duplicates, 3);
      assert.equal(
        snapshot.runs.find(
          (item: { run_id: string }) => item.run_id === run.run_id,
        ).source,
        "local",
      );
      assert.equal(
        snapshot.integrations.some(
          (integration: { cid: string }) =>
            integration.cid === "local-simulator",
        ),
        false,
      );
      assert.ok(
        snapshot.events.every(
          (event: { id: string }, index: number, events: { id: string }[]) =>
            index === 0 || BigInt(events[index - 1]!.id) > BigInt(event.id),
        ),
        "Eventos ordenados pelo número do ID, não pelo texto.",
      );
    },
  );
});
