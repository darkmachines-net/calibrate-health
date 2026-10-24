#!/usr/bin/env node
/** @file Resets onboarding only for the configured local seeded test account. */

/**
 * Dev helper: reset the deterministic local test account back to a pre-onboarding state.
 *
 * This hits the backend dev-only route so developers can re-test onboarding without creating
 * a separate account or clearing cookies.
 */

const backendPortEnv = process.env.BACKEND_PORT || process.env.PORT;
const backendPort = backendPortEnv ? Number.parseInt(backendPortEnv, 10) : 3000;
const port = Number.isFinite(backendPort) && backendPort > 0 ? backendPort : 3000;

const url = `http://localhost:${port}/dev/test/reset-test-user-onboarding`;

try {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const message = payload && typeof payload.message === 'string' ? payload.message : res.statusText;
    console.error(`Reset failed (${res.status}): ${message}`);
    process.exitCode = 1;
    process.exit();
  }

  const email = payload?.user?.email;
  console.log(`Reset OK${typeof email === 'string' ? ` (${email})` : ''}`);
} catch (error) {
  console.error('Reset failed: unable to reach backend dev route.');
  if (error instanceof Error && error.message) {
    console.error(error.message);
  }
  process.exitCode = 1;
}

