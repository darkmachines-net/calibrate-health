/** @file docker runtime: Ensure the Docker daemon used by the repository development stack is available. */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const DOCKER_START_TIMEOUT_MS = 120_000;
const DOCKER_POLL_INTERVAL_MS = 2_000;

function runDocker(args, stdio = 'ignore') {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    stdio,
    shell: false
  });
}

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Ensure the Docker daemon used by the repository development stack is available. */
export async function ensureDockerRuntime({
  platform = process.platform,
  inspect = () => runDocker(['info']),
  startDesktop = () => runDocker(['desktop', 'start'], 'inherit'),
  wait = delay,
  timeoutMs = DOCKER_START_TIMEOUT_MS,
  pollIntervalMs = DOCKER_POLL_INTERVAL_MS
} = {}) {
  const initial = inspect();
  if (initial.status === 0) return { started: false };
  if (initial.error?.code === 'ENOENT') {
    throw new Error('Docker is required for local development. Install Docker Desktop, then run npm run dev again.');
  }
  if (platform !== 'win32' && platform !== 'darwin') {
    throw new Error('The Docker daemon is not running. Start Docker, then run npm run dev again.');
  }

  console.log('[dev] Docker is installed but not running; starting Docker Desktop...');
  startDesktop();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(pollIntervalMs);
    if (inspect().status === 0) return { started: true };
  }

  throw new Error(
    'Docker Desktop did not become ready. Open Docker Desktop once to resolve its system startup error, then rerun npm run dev.'
  );
}
