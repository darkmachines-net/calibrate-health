/** @file Launches the supported Expo browser test workflow with host-safe process arguments. */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createExpoWebStaticServer } from './expo-web-static-server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = path.join(repoRoot, 'mobile');
const callerOwnedBaseURL = process.env.CALIBRATE_EXPO_WEB_BASE_URL?.trim();
const portText = process.env.CALIBRATE_EXPO_WEB_PORT?.trim() || '4174';
if (!/^\d+$/.test(portText)) throw new Error(`Invalid Expo web test port: ${portText}`);
const baseURL = `http://127.0.0.1:${portText}`;
const playwrightCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const DATA_STATE_MATRIX_SPEC = path.normalize('e2e/expo-web/launch-24-data-state-matrix.spec.ts');
const supportedConfigs = new Set(['playwright.expo-web.config.ts', 'playwright.ux.config.ts']);
const playwrightConfig = process.env.CALIBRATE_PLAYWRIGHT_CONFIG?.trim()
  || 'playwright.expo-web.config.ts';
if (!supportedConfigs.has(playwrightConfig)) {
  throw new Error(`Unsupported Playwright config: ${playwrightConfig}`);
}
const requestedArguments = process.argv.slice(2);
const dataStateMatrixRequested = requestedArguments.some((argument) => (
  path.normalize(argument) === DATA_STATE_MATRIX_SPEC
));
const requestsSnapshotUpdate = requestedArguments.some((argument) => (
  argument === '--update-snapshots' || argument.startsWith('--update-snapshots=')
));
if (requestsSnapshotUpdate && process.env.CALIBRATE_APPROVE_UX_SNAPSHOTS !== '1') {
  throw new Error('CALIBRATE_APPROVE_UX_SNAPSHOTS=1 is required to update snapshots.');
}
const playwrightArgs = ['test', '--config', playwrightConfig, ...requestedArguments];

function runPlaywright(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [playwrightCli, ...playwrightArgs], {
      cwd: repoRoot,
      env: {
        ...env,
        CALIBRATE_INCLUDE_DATA_STATE_MATRIX: dataStateMatrixRequested ? '1' : '0',
      },
      stdio: 'inherit',
    });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function resolveNpmCli() {
  const inheritedNpmCli = process.env.npm_execpath;
  const installedNpmCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  const npmCli = inheritedNpmCli || (fs.existsSync(installedNpmCli) ? installedNpmCli : '');
  if (!npmCli) {
    throw new Error('Unable to locate npm. Run this command through a repository npm script.');
  }
  return npmCli;
}

if (callerOwnedBaseURL) {
  process.exitCode = await runPlaywright(process.env);
} else {
  // Use the package lifecycle so prebuild:web compiles @calibrate/shared in fresh checkouts.
  const build = spawnSync(process.execPath, [resolveNpmCli(), '--prefix', mobileDir, 'run', 'build:web'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const server = createExpoWebStaticServer({ distDir: path.join(repoRoot, 'mobile', 'dist') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(portText), '127.0.0.1', resolve);
  });
  console.log(`Expo web release test server listening at ${baseURL}`);
  try {
    process.exitCode = await runPlaywright({
      ...process.env,
      CALIBRATE_EXPO_WEB_BASE_URL: baseURL,
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
