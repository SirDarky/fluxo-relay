import { RemoteError } from './integration/platform-client.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}
export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 30000, jitterRatio: 0.2,
};

export function validateRetryPolicy(policy: RetryPolicy) {
  const maxDelay = policy.maxDelayMs ?? 30000;
  const jitter = policy.jitterRatio ?? 0.2;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 20
    || !Number.isInteger(policy.baseDelayMs) || policy.baseDelayMs < 1
    || !Number.isInteger(maxDelay) || maxDelay < policy.baseDelayMs || maxDelay > 300000
    || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new Error('Política de tentativas inválida: confira limite, espera, teto e jitter.');
  }
}

// A tentativa inicial é imediata. Depois de cada falha: 1, 1, 2, 3, 5, 8, 13...
export function fibonacciDelay(attempt: number, policy: RetryPolicy) {
  validateRetryPolicy(policy);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 20)
    throw new Error('Número da tentativa inválido.');
  let previous = 0;
  let current = 1;
  for (let index = 1; index < attempt; index += 1) {
    [previous, current] = [current, previous + current];
  }
  return Math.min(policy.maxDelayMs ?? 30000, policy.baseDelayMs * current);
}

export function retryDecision(error: unknown, attempts: number, policy: RetryPolicy,
  clock: { now: () => number; random: () => number } = { now: Date.now, random: Math.random }) {
  const backoff = fibonacciDelay(attempts, policy);
  const terminal = (error instanceof RemoteError && !error.retryable) || attempts >= policy.maxAttempts;
  const jitter = Math.floor(backoff * clock.random() * (policy.jitterRatio ?? 0.2));
  // O teto se aplica ao Fibonacci + jitter. Retry-After sempre prevalece se for maior.
  const delayMs = terminal ? 0 : Math.max(
    Math.min(policy.maxDelayMs ?? 30000, backoff + jitter),
    error instanceof RemoteError ? error.retryAfterMs : 0,
  );
  return {
    terminal,
    delayMs,
    nextAttempt: new Date(clock.now() + delayMs),
    message: error instanceof Error ? error.message : 'Falha desconhecida.',
  };
}
