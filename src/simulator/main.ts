import Fastify from "fastify";
import { setTimeout as delay } from "node:timers/promises";

// Plataforma exclusivamente local. Este processo não tem cliente HTTP de saída.
const app = Fastify({ logger: false });
const attempts = new Map<string, { count: number; at: number }>();
app.get("/health", async () => ({ ok: true, source: "local-simulator" }));
app.get<{ Params: { sku: string } }>("/enrich/:sku", async (request, reply) => {
  if (
    request.headers["x-cid"] !== "local-simulator" ||
    request.headers["x-token"] !== "local-only"
  )
    return reply.code(401).send({ error: "local_credentials" });
  const sku = request.params.sku;
  const match = /^demo-[a-f0-9]+-(happy|resilient)-(\d+)$/.exec(sku);
  if (!match) return reply.code(404).send({ error: "unknown_local_sku" });
  const count = (attempts.get(sku)?.count ?? 0) + 1;
  attempts.set(sku, { count, at: Date.now() });
  const seq = Number(match[2]);
  await delay(400 + (seq % 5) * 80);
  if (match[1] === "resilient" && count === 1 && seq === 7)
    return reply.code(500).send({ error: "simulated_transient_failure" });
  if (match[1] === "resilient" && count === 1 && seq === 13)
    return reply
      .code(429)
      .header("retry-after", "1")
      .send({ error: "simulated_rate_limit" });
  return {
    sku,
    price: Number((19.9 + seq * 7.35).toFixed(2)),
    stock: 10 + seq * 3,
  };
});
app.post<{ Body: { run_id: string; cid: string; result: unknown[] } }>(
  "/callback",
  async (request, reply) => {
    if (
      request.headers["x-token"] !== "local-only" ||
      request.body?.cid !== "local-simulator"
    )
      return reply.code(401).send({ error: "local_credentials" });
    if (
      !Array.isArray(request.body.result) ||
      request.body.result.length !== 20
    )
      return reply.code(400).send({ error: "incomplete_local_batch" });
    return {
      source: "local-simulator",
      run_id: request.body.run_id,
      received: 20,
      accepted: true,
      note: "Simulação local. Este relatório não é uma avaliação da plataforma externa.",
    };
  },
);
const cleanup = setInterval(() => {
  for (const [key, value] of attempts)
    if (Date.now() - value.at > 3600000) attempts.delete(key);
}, 60000);
cleanup.unref();
process.once("SIGINT", () => {
  void app.close();
});
process.once("SIGTERM", () => {
  void app.close();
});
await app.listen({
  port: Number(process.env.SIMULATOR_PORT ?? 4300),
  host: process.env.HOST ?? "127.0.0.1",
});
