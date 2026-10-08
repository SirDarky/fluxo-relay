import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

export function recordAcknowledgements(app: FastifyInstance, pool: Pool) {
  let pending: {
    run_id: string | null;
    seq: number | null;
    status: number;
    duration_ms: number;
  }[] = [];
  let dropped = 0;
  let flushing: Promise<void> | undefined;
  function flush() {
    if (flushing || !pending.length) return flushing;
    const batch = pending;
    pending = [];
    flushing = pool
      .query(
        `INSERT INTO ack_samples (run_id, seq, status, duration_ms)
      SELECT run_id, seq, status, duration_ms FROM jsonb_to_recordset($1::jsonb)
      AS x(run_id text, seq integer, status integer, duration_ms double precision)`,
        [JSON.stringify(batch)],
      )
      .then(() => {})
      .catch(() => {
        dropped += batch.length;
      })
      .finally(() => {
        flushing = undefined;
      });
    return flushing;
  }
  const timer = setInterval(() => {
    void flush();
  }, 500);
  timer.unref();
  app.addHook("onResponse", async (request, reply) => {
    if (request.routeOptions.url !== "/process") return;
    if (pending.length >= 1000) {
      dropped++;
      return;
    }
    const body = request.body as Record<string, unknown> | undefined;
    pending.push({
      run_id:
        typeof body?.run_id === "string" ? body.run_id.slice(0, 256) : null,
      seq:
        Number.isInteger(body?.seq) &&
        Number(body?.seq) >= 0 &&
        Number(body?.seq) <= 2147483647
          ? Number(body?.seq)
          : null,
      status: reply.statusCode,
      duration_ms: reply.elapsedTime,
    });
  });
  return {
    dropped: () => dropped,
    async close() {
      clearInterval(timer);
      await flushing;
      await flush();
    },
  };
}
