/** @file Blocking accessibility/visual test orchestration and explicit guarded snapshot updates. */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const UX_PLAYWRIGHT_CONFIG = 'playwright.ux.config.ts';
export const UX_ACCESSIBILITY_SPEC = 'e2e/expo-web/launch-22-accessibility.spec.ts';
export const UX_VISUAL_SPEC = 'e2e/expo-web/launch-22-visual.spec.ts';
export const UX_ACCESSIBILITY_PROJECTS = Object.freeze(['ux-phone-320', 'ux-desktop-1024']);
export const UX_SNAPSHOT_APPROVAL_ENV = 'CALIBRATE_APPROVE_UX_SNAPSHOTS';
export const UX_RESULTS_DIRECTORY = '.codex-screenshots/expo-web-ux-results';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightWrapper = path.join(repositoryRoot, 'scripts', 'expo-web-playwright.mjs');
const MODES = new Set(['a11y', 'visual', 'all', 'update-snapshots']);

/** Requires one supported accessibility, visual, combined, or snapshot-update mode. */
export function parseUxGateMode(argumentsList) {
  if (argumentsList.length !== 1 || !MODES.has(argumentsList[0])) {
    throw new Error('Usage: node scripts/ux-gates.mjs <a11y|visual|all|update-snapshots>.');
  }
  return argumentsList[0];
}

/** Build one Playwright invocation so each UX command builds and serves the export only once. */
export function createUxGateInvocation(mode, environment = process.env) {
  if (!MODES.has(mode)) throw new Error(`Unknown UX gate mode: ${mode}.`);

  const updateSnapshots = mode === 'update-snapshots';
  if (updateSnapshots && environment[UX_SNAPSHOT_APPROVAL_ENV] !== '1') {
    throw new Error(
      `${UX_SNAPSHOT_APPROVAL_ENV}=1 is required to update reviewed UX snapshots.`,
    );
  }

  const playwrightArguments = [];
  if (mode === 'a11y') {
    playwrightArguments.push(
      UX_ACCESSIBILITY_SPEC,
      ...UX_ACCESSIBILITY_PROJECTS.map((project) => `--project=${project}`),
    );
  } else if (mode === 'visual') {
    playwrightArguments.push(UX_VISUAL_SPEC);
  } else {
    playwrightArguments.push(UX_ACCESSIBILITY_SPEC, UX_VISUAL_SPEC);
  }
  if (updateSnapshots) playwrightArguments.push('--update-snapshots=all');

  return {
    command: process.execPath,
    args: [playwrightWrapper, ...playwrightArguments],
    environment: {
      ...environment,
      CALIBRATE_PLAYWRIGHT_CONFIG: UX_PLAYWRIGHT_CONFIG,
      CALIBRATE_UX_GATE_MODE: mode,
    },
    updateSnapshots,
  };
}

function writeSanitizedSummary(mode, status, updateSnapshots) {
  const resultsDirectory = path.join(repositoryRoot, UX_RESULTS_DIRECTORY);
  fs.mkdirSync(resultsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDirectory, `ux-gate-${mode}.json`),
    `${JSON.stringify({
      schema_version: 1,
      gate: mode,
      status,
      playwright_config: UX_PLAYWRIGHT_CONFIG,
      snapshot_update: updateSnapshots,
    }, null, 2)}\n`,
  );
}

/** Runs the repository-owned UX gate and writes a sanitized result summary. */
export function runUxGate(mode, environment = process.env) {
  const invocation = createUxGateInvocation(mode, environment);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    env: invocation.environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  const status = result.error ? 1 : (result.status ?? 1);
  writeSanitizedSummary(
    mode,
    status === 0 ? 'passed' : 'failed',
    invocation.updateSnapshots,
  );
  if (result.error) throw new Error('Unable to start the UX Playwright gate.');
  return status;
}

if (
  process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const mode = parseUxGateMode(process.argv.slice(2));
    process.exitCode = runUxGate(mode);
  } catch (error) {
    console.error(`[ux-gates] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
