/** @file calibration lab: Bundles the calibration lab in memory using the shared React Native Web presentation. */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild-wasm';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const assetDirectory = resolve(repositoryRoot, 'tools', 'calibration-lab');
const responseAssets = new Map([
  ['/', { path: resolve(assetDirectory, 'index.html'), contentType: 'text/html; charset=utf-8' }],
  ['/styles.css', { path: resolve(assetDirectory, 'styles.css'), contentType: 'text/css; charset=utf-8' }]
]);

/** Bundles the calibration lab in memory using the shared React Native Web presentation. */
export async function buildCalibrationLabBundle() {
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: ['tools/calibration-lab/main.tsx'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: ['es2022'],
    banner: {
      js: 'var process = globalThis.process ?? { env: { NODE_ENV: "development" } };'
    },
    alias: {
      'react-native': 'react-native-web'
    },
    conditions: ['browser', 'react-native', 'default'],
    mainFields: ['browser', 'module', 'main'],
    resolveExtensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.jsx', '.web.js', '.jsx', '.js', '.json'],
    define: {
      __DEV__: 'true',
      global: 'globalThis',
      'process.env.NODE_ENV': '"development"',
      'process.env.EXPO_OS': '"web"'
    },
    loader: {
      '.js': 'jsx',
      '.ttf': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.png': 'dataurl'
    },
    plugins: [{
      name: 'browser-only-expo-font-context',
      setup(builder) {
        builder.onResolve({ filter: /^node:async_hooks$/ }, () => ({
          path: 'async-hooks-browser-stub',
          namespace: 'calibration-lab'
        }));
        builder.onLoad({ filter: /.*/, namespace: 'calibration-lab' }, () => ({
          contents: 'export class AsyncLocalStorage { getStore() { return undefined; } run(_store, callback) { return callback(); } }',
          loader: 'js'
        }));
      }
    }],
    logLevel: 'silent'
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error('Calibration lab browser bundle was not generated.');
  return output.contents;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function requireNonNegativeNumber(value, label) {
  const parsed = requireFiniteNumber(value, label);
  if (parsed < 0) throw new Error(`${label} must be zero or greater.`);
  return parsed;
}

function requireNonNegativeInteger(value, label) {
  const parsed = requireNonNegativeNumber(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer.`);
  return parsed;
}

function requireDateOnly(value, label) {
  const parsed = requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date.`);
  }
  return parsed;
}

function requireUniqueDates(values, label) {
  const seen = new Set();
  values.forEach((value, index) => {
    const date = value.date;
    if (seen.has(date)) throw new Error(`${label}[${index}].date duplicates ${date}.`);
    seen.add(date);
  });
}

/** Validates uploaded calibration history records and dates before running the lab evaluator. */
export function parseCalibrationInput(value) {
  const parsed = requireRecord(value, 'History input');
  if (!Array.isArray(parsed.foodDays)) throw new Error('foodDays must be an array.');
  if (!Array.isArray(parsed.weightPoints)) throw new Error('weightPoints must be an array.');

  parsed.foodDays.forEach((value, index) => {
    const day = requireRecord(value, `foodDays[${index}]`);
    requireDateOnly(day.date, `foodDays[${index}].date`);
    requireNonNegativeNumber(day.calories, `foodDays[${index}].calories`);
    requireNonNegativeInteger(day.entryCount, `foodDays[${index}].entryCount`);
    requireNonNegativeInteger(day.mealPeriodCount, `foodDays[${index}].mealPeriodCount`);
    if (typeof day.isComplete !== 'boolean') {
      throw new Error(`foodDays[${index}].isComplete must be a boolean.`);
    }
  });
  requireUniqueDates(parsed.foodDays, 'foodDays');
  parsed.weightPoints.forEach((value, index) => {
    const point = requireRecord(value, `weightPoints[${index}]`);
    requireDateOnly(point.date, `weightPoints[${index}].date`);
    const weightKg = requireNonNegativeNumber(point.weightKg, `weightPoints[${index}].weightKg`);
    if (weightKg === 0) throw new Error(`weightPoints[${index}].weightKg must be greater than zero.`);
  });
  requireUniqueDates(parsed.weightPoints, 'weightPoints');

  if (parsed.activityDays !== undefined) {
    if (!Array.isArray(parsed.activityDays)) throw new Error('activityDays must be an array when provided.');
    parsed.activityDays.forEach((value, index) => {
      const day = requireRecord(value, `activityDays[${index}]`);
      requireDateOnly(day.date, `activityDays[${index}].date`);
      if (day.steps !== undefined && day.steps !== null) {
        requireNonNegativeNumber(day.steps, `activityDays[${index}].steps`);
      }
      if (day.activeCaloriesKcal !== undefined && day.activeCaloriesKcal !== null) {
        requireNonNegativeNumber(day.activeCaloriesKcal, `activityDays[${index}].activeCaloriesKcal`);
      }
    });
    requireUniqueDates(parsed.activityDays, 'activityDays');
  }

  requireDateOnly(parsed.asOfDate, 'asOfDate');
  if (parsed.weightUnit !== 'KG' && parsed.weightUnit !== 'LB') {
    throw new Error('weightUnit must be KG or LB.');
  }
  const ageYears = requireNonNegativeNumber(parsed.ageYears, 'ageYears');
  if (ageYears > 120) throw new Error('ageYears must be 120 or less.');
  const bmrKcal = requireNonNegativeNumber(parsed.bmrKcal, 'bmrKcal');
  const profileTdeeKcal = requireNonNegativeNumber(parsed.profileTdeeKcal, 'profileTdeeKcal');
  if (bmrKcal === 0 || profileTdeeKcal === 0) throw new Error('bmrKcal and profileTdeeKcal must be greater than zero.');
  if (profileTdeeKcal < bmrKcal) throw new Error('profileTdeeKcal cannot be lower than bmrKcal.');
  requireFiniteNumber(parsed.configuredDailyDeficitKcal, 'configuredDailyDeficitKcal');
  requireFiniteNumber(parsed.currentTargetAdjustmentKcal, 'currentTargetAdjustmentKcal');
  return parsed;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('History input exceeds the 1 MB limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

/** Creates the lab HTTP server with injected evaluation, scenarios, and browser bundle. */
export function createCalibrationLabServer({ evaluateCalibration, scenarios, browserBundle = new Uint8Array() }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/scenarios') {
        sendJson(response, 200, scenarios);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/evaluate') {
        const input = parseCalibrationInput(await readJsonBody(request));
        sendJson(response, 200, evaluateCalibration(input));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/main.js') {
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store'
        });
        response.end(browserBundle);
        return;
      }
      const asset = request.method === 'GET' ? responseAssets.get(url.pathname) : undefined;
      if (asset) {
        response.writeHead(200, { 'content-type': asset.contentType, 'cache-control': 'no-store' });
        response.end(await readFile(asset.path));
        return;
      }
      sendJson(response, 404, { message: 'Not found' });
    } catch (error) {
      sendJson(response, 400, {
        message: error instanceof Error ? error.message : 'Invalid calibration history.'
      });
    }
  });
}

async function start() {
  const require = createRequire(import.meta.url);
  const { evaluateCalibration } = require(resolve(repositoryRoot, 'shared', 'dist', 'cjs', 'calibration.js'));
  const { CALIBRATION_SCENARIOS } = require(resolve(repositoryRoot, 'shared', 'dist', 'cjs', 'calibrationScenarios.js'));
  const port = Number.parseInt(process.env.CALIBRATION_LAB_PORT ?? '5173', 10);
  const browserBundle = await buildCalibrationLabBundle();
  const server = createCalibrationLabServer({ evaluateCalibration, scenarios: CALIBRATION_SCENARIOS, browserBundle });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Calibration history lab: http://127.0.0.1:${port}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
}
