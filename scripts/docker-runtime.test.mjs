/** @file Regression coverage for docker runtime: an already-running Docker daemon needs no desktop startup. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureDockerRuntime } from './docker-runtime.mjs';

test('an already-running Docker daemon needs no desktop startup', async () => {
  let starts = 0;
  const result = await ensureDockerRuntime({
    inspect: () => ({ status: 0 }),
    startDesktop: () => { starts += 1; }
  });
  assert.deepEqual(result, { started: false });
  assert.equal(starts, 0);
});

test('Docker Desktop is started and polled on supported desktop platforms', async () => {
  let inspections = 0;
  let starts = 0;
  const result = await ensureDockerRuntime({
    platform: 'win32',
    inspect: () => ({ status: inspections++ >= 2 ? 0 : 1 }),
    startDesktop: () => { starts += 1; return { status: 0 }; },
    wait: async () => undefined,
    timeoutMs: 10_000,
    pollIntervalMs: 1
  });
  assert.deepEqual(result, { started: true });
  assert.equal(starts, 1);
  assert.equal(inspections, 3);
});

test('a missing Docker installation produces an actionable error', async () => {
  await assert.rejects(
    ensureDockerRuntime({ inspect: () => ({ status: null, error: { code: 'ENOENT' } }) }),
    /Install Docker Desktop/
  );
});

test('a daemon startup timeout produces an actionable error', async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    await assert.rejects(
      ensureDockerRuntime({
        platform: 'darwin',
        inspect: () => ({ status: 1 }),
        startDesktop: () => ({ status: 1 }),
        wait: async (delayMs) => { now += delayMs; },
        timeoutMs: 2,
        pollIntervalMs: 1
      }),
      /did not become ready/
    );
  } finally {
    Date.now = originalNow;
  }
});
