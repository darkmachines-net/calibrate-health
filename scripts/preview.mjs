/** @file Local backend and Expo web preview process orchestration with coordinated shutdown. */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const backendDir = path.join(repoRoot, 'backend');
const mobileDir = path.join(repoRoot, 'mobile');

const services = [
  { name: 'backend', cwd: backendDir, args: ['run', 'dev'] },
  { name: 'expo-web-preview', cwd: mobileDir, args: ['run', 'preview:web'] },
];

const states = new Map();
let shuttingDown = false;
let finalExitCode = 0;

/**
 * Stop any running child processes so preview doesn't leave orphaned servers.
 */
function killAll(signal) {
  for (const { child } of states.values()) {
    if (!child.killed) child.kill(signal);
  }
}

/**
 * Exit once all services have finished, preserving the first non-zero code.
 */
function maybeExit() {
  const allExited = [...states.values()].every(({ exited }) => exited);
  if (allExited) process.exit(finalExitCode);
}

/**
 * Fan out shutdown signals so backend and preview exit together.
 */
function shutdown(exitCode, signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  finalExitCode = exitCode;
  killAll(signal);
  setTimeout(() => process.exit(finalExitCode), 10_000).unref();
}

for (const service of services) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : npmCmd;
  const args = npmExecPath ? [npmExecPath, ...service.args] : service.args;
  const child = spawn(command, args, {
    cwd: service.cwd,
    stdio: 'inherit',
    shell: !npmExecPath && process.platform === 'win32',
  });

  states.set(service.name, { child, exited: false });

  child.on('exit', (code, signal) => {
    const state = states.get(service.name);
    if (state) state.exited = true;

    if (!shuttingDown) {
      shutdown(code ?? 1, signal ?? 'SIGTERM');
    } else if (typeof code === 'number' && code !== 0) {
      finalExitCode = code;
    }

    maybeExit();
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0, signal));
}
