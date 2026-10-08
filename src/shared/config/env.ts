// Configuração compartilhada; cada processo recebe seu próprio ambiente.
const apiPort = Number(process.env.API_PORT ?? 4000);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  throw new Error("API_PORT precisa ser uma porta válida.");
}

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
if (!["redis:", "rediss:"].includes(new URL(redisUrl).protocol)) {
  throw new Error("REDIS_URL precisa usar redis:// ou rediss://.");
}

if (
  process.env.PROCESSING_ENABLED &&
  !["true", "false"].includes(process.env.PROCESSING_ENABLED)
) {
  throw new Error("PROCESSING_ENABLED precisa ser true ou false.");
}
if (
  process.env.DASHBOARD_TOKEN &&
  !/^[a-fA-F0-9]{32,128}$/.test(process.env.DASHBOARD_TOKEN)
) {
  throw new Error(
    "DASHBOARD_TOKEN precisa ter de 32 a 128 caracteres hexadecimais.",
  );
}
const simulatorBaseUrl =
  process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:4300";
const simulatorUrl = new URL(simulatorBaseUrl);
if (
  simulatorUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "simulator"].includes(simulatorUrl.hostname)
) {
  throw new Error("SIMULATOR_BASE_URL precisa apontar para o simulador local.");
}

const retryMaxAttempts = Number(process.env.RETRY_MAX_ATTEMPTS ?? 8);
const retryBaseDelayMs = Number(process.env.RETRY_BASE_DELAY_MS ?? 500);
const retryMaxDelayMs = Number(process.env.RETRY_MAX_DELAY_MS ?? 30000);
if (!Number.isInteger(retryMaxAttempts) || retryMaxAttempts < 1 || retryMaxAttempts > 20
  || !Number.isInteger(retryBaseDelayMs) || retryBaseDelayMs < 1
  || !Number.isInteger(retryMaxDelayMs) || retryMaxDelayMs < retryBaseDelayMs || retryMaxDelayMs > 300000) {
  throw new Error('Confira RETRY_MAX_ATTEMPTS (1–20), RETRY_BASE_DELAY_MS e RETRY_MAX_DELAY_MS (até 300000).');
}

export const env = {
  apiPort,
  host: process.env.HOST ?? "127.0.0.1",
  databaseUrl: process.env.DATABASE_URL,
  redisUrl,
  logLevel: process.env.LOG_LEVEL ?? "info",
  platformBaseUrl:
    process.env.PLATFORM_BASE_URL ??
    "https://dev-wdu-ped-test-1014944555984.us-central1.run.app",
  processingEnabled: process.env.PROCESSING_ENABLED === "true",
  simulationEnabled: process.env.SIMULATION_ENABLED !== "false",
  simulatorBaseUrl,
  dashboardToken: process.env.DASHBOARD_TOKEN ?? "",
  retryPolicy: { maxAttempts: retryMaxAttempts, baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs, jitterRatio: 0.2 },
};
