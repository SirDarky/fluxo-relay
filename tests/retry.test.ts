import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultRetryPolicy, fibonacciDelay, retryDecision, validateRetryPolicy } from '../src/worker/retry.js';
import { RemoteError } from '../src/worker/integration/platform-client.js';

const transient = new RemoteError('HTTP 500', true, 0, 500);
const clock = { now: () => 100000, random: () => 0 };

test('Fibonacci cresce pela soma anterior, com teto e sem overflow', () => {
  assert.deepEqual(Array.from({ length: 10 }, (_, index) => fibonacciDelay(index+1, defaultRetryPolicy)),
    [500,500,1000,1500,2500,4000,6500,10500,17000,27500]);
  assert.equal(fibonacciDelay(20, defaultRetryPolicy), 30000);
});

test('jitter distribui as repetições e continua respeitando o teto', () => {
  const first = retryDecision(transient, 3, defaultRetryPolicy, clock);
  const other = retryDecision(transient, 3, defaultRetryPolicy, { ...clock, random: () => 0.75 });
  assert.equal(first.delayMs, 1000);
  assert.equal(other.delayMs, 1150);
  assert.equal(other.nextAttempt.getTime(), 101150);
  assert.equal(retryDecision(transient, 12, { ...defaultRetryPolicy, maxAttempts: 20 },
    { ...clock, random: () => 0.99 }).delayMs, 30000);
});

test('Retry-After maior prevalece sobre o teto de backoff; menor não antecipa Fibonacci', () => {
  assert.equal(retryDecision(new RemoteError('HTTP 429', true, 60000, 429), 1, defaultRetryPolicy, clock).delayMs, 60000);
  assert.equal(retryDecision(new RemoteError('HTTP 429', true, 100, 429), 4, defaultRetryPolicy, clock).delayMs, 1500);
});

test('falhas definitivas e limite total encerram sem agendar espera', () => {
  for (const status of [401,404]) {
    const decision = retryDecision(new RemoteError(`HTTP ${status}`, false, 0, status), 1, defaultRetryPolicy, clock);
    assert.equal(decision.terminal, true);
    assert.equal(decision.delayMs, 0);
  }
  assert.equal(retryDecision(transient, 7, defaultRetryPolicy, clock).terminal, false);
  assert.equal(retryDecision(transient, 8, defaultRetryPolicy, clock).terminal, true);
  assert.equal(retryDecision(transient, 8, defaultRetryPolicy, clock).delayMs, 0);
});

test('configuração e contagem inválidas são recusadas antes de processar', () => {
  for (const policy of [
    { maxAttempts: 0, baseDelayMs: 500 }, { maxAttempts: 21, baseDelayMs: 500 },
    { maxAttempts: 8, baseDelayMs: 0 }, { maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 100 },
    { maxAttempts: 8, baseDelayMs: 500, jitterRatio: NaN },
  ]) assert.throws(() => validateRetryPolicy(policy));
  for (const attempt of [0,-1,NaN,1.5,21]) assert.throws(() => fibonacciDelay(attempt, defaultRetryPolicy));
});
