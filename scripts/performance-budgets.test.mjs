/** @file Regression coverage for performance budgets: measures exact reachable gzip graphs for every representative route. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertBenchmarkRuntime,
  assertBundleRuntime,
  evaluateRouteBundleGrowth,
  measureRouteBundleGraphs,
  REPRESENTATIVE_ROUTES,
  REQUIRED_BENCHMARK_RUNTIME,
  REQUIRED_BUNDLE_RUNTIME,
  validatePerformanceBudgetManifest,
} from './performance-budgets.mjs';

function manifestFor(gzipBytes, overrides = {}) {
  return {
    schema_version: 1,
    limits: {
      largest_contentful_paint_ms: 2500,
      cumulative_layout_shift: 0.1,
      interaction_to_next_paint_ms: 200,
      route_bundle_growth_percent: 5,
      api_recompute_regression_percent: 10,
      ...overrides,
    },
    route_bundle_baselines: Object.fromEntries(REPRESENTATIVE_ROUTES.map((route) => [route, { gzip_bytes: gzipBytes }])),
    benchmark_baselines: {
      diagnostics_snapshot_serialization: { median_ratio_ppm: 1000000 },
      weight_trend_recompute: { median_ratio_ppm: 1000000 },
    },
    benchmark_runtime: { ...REQUIRED_BENCHMARK_RUNTIME },
    bundle_runtime: { ...REQUIRED_BUNDLE_RUNTIME },
    baseline_review: {
      reference: 'issue-301',
      owner_role: 'release_engineer',
      reviewed_on: '2026-08-09',
      rationale: 'Reviewed deterministic fixture baseline for the test artifact.',
    },
  };
}

function createDistFixture() {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-performance-budget-'));
  const bundleDir = path.join(distDir, '_expo', 'static', 'js', 'web');
  fs.mkdirSync(bundleDir, { recursive: true });
  const entryPath = '_expo/static/js/web/index-a1b2c3d4e5f60718.js';
  const deferredPath = '_expo/static/js/web/index-feed1234feed1234.js';
  const namedDeferredPath = '_expo/static/js/web/ImagePicker-0de4dad54ce0ff99.js';
  fs.writeFileSync(
    path.join(bundleDir, 'index-a1b2c3d4e5f60718.js'),
    `load('/${deferredPath}'); load('/${namedDeferredPath}'); load('/_expo/static/js/web/../unsafe-feed1234.js');`,
  );
  fs.writeFileSync(path.join(bundleDir, 'index-feed1234feed1234.js'), 'export const calibrated = true;');
  fs.writeFileSync(path.join(bundleDir, 'ImagePicker-0de4dad54ce0ff99.js'), 'export const selected = true;');
  const html = `<script src="/${entryPath}"></script>`;
  for (const route of REPRESENTATIVE_ROUTES) {
    fs.writeFileSync(route === '/' ? path.join(distDir, 'index.html') : path.join(distDir, `${route.slice(1)}.html`), html);
  }
  return distDir;
}

test('measures exact reachable gzip graphs for every representative route', (t) => {
  const distDir = createDistFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  const measured = measureRouteBundleGraphs(distDir);
  const first = measured['/'];
  assert.deepEqual(first.bundles, [
    '_expo/static/js/web/ImagePicker-0de4dad54ce0ff99.js',
    '_expo/static/js/web/index-a1b2c3d4e5f60718.js',
    '_expo/static/js/web/index-feed1234feed1234.js',
  ]);
  assert.ok(first.gzip_bytes > 0);
  for (const route of REPRESENTATIVE_ROUTES) assert.equal(measured[route].gzip_bytes, first.gzip_bytes);
});

test('allows five-percent route growth and rejects any larger increase', () => {
  const measured = Object.fromEntries(REPRESENTATIVE_ROUTES.map((route) => [route, { gzip_bytes: 1050, bundles: [] }]));
  assert.doesNotThrow(() => evaluateRouteBundleGrowth(measured, manifestFor(1000)));
  measured['/today'].gzip_bytes = 1051;
  assert.throws(() => evaluateRouteBundleGrowth(measured, manifestFor(1000)), /\/today: 1051 gzip bytes is 5\.10%/);
});

test('rejects missing, non-finite, negative, weakened, or extra limits', () => {
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2501]) {
    const invalid = manifestFor(1000, { largest_contentful_paint_ms: value });
    assert.throws(() => validatePerformanceBudgetManifest(invalid), /largest_contentful_paint_ms/);
  }
  const extra = manifestFor(1000);
  extra.limits.unreviewed_limit = 1;
  assert.throws(() => validatePerformanceBudgetManifest(extra), /exactly/);
});

test('requires exact positive integer route and benchmark baselines', () => {
  const missingRoute = manifestFor(1000);
  delete missingRoute.route_bundle_baselines['/settings'];
  assert.throws(() => validatePerformanceBudgetManifest(missingRoute), /exactly/);
  const fractionalRoute = manifestFor(1000);
  fractionalRoute.route_bundle_baselines['/today'].gzip_bytes = 12.5;
  assert.throws(() => validatePerformanceBudgetManifest(fractionalRoute), /positive integer/);
  const missingBenchmark = manifestFor(1000);
  delete missingBenchmark.benchmark_baselines.weight_trend_recompute;
  assert.throws(() => validatePerformanceBudgetManifest(missingBenchmark), /exactly/);
  const invalidBenchmark = manifestFor(1000);
  invalidBenchmark.benchmark_baselines.weight_trend_recompute.median_ratio_ppm = Number.NaN;
  assert.throws(() => validatePerformanceBudgetManifest(invalidBenchmark), /positive integer/);
});

test('requires the reviewed benchmark runtime and rejects a mismatched executor', () => {
  const manifest = manifestFor(1000);
  assert.doesNotThrow(() => assertBenchmarkRuntime(manifest, { ...REQUIRED_BENCHMARK_RUNTIME }));
  assert.throws(
    () => assertBenchmarkRuntime(manifest, { ...REQUIRED_BENCHMARK_RUNTIME, node: '26.4.0' }),
    /runtime mismatch for node/,
  );
  manifest.benchmark_runtime.v8 = 'unreviewed-v8';
  assert.throws(() => validatePerformanceBudgetManifest(manifest), /reviewed value/);
});

test('requires the reviewed bundle runtime including zlib and rejects a mismatched executor', () => {
  const manifest = manifestFor(1000);
  assert.doesNotThrow(() => assertBundleRuntime(manifest, { ...REQUIRED_BUNDLE_RUNTIME }));
  assert.throws(
    () => assertBundleRuntime(manifest, { ...REQUIRED_BUNDLE_RUNTIME, zlib: '1.3.2' }),
    /bundle runtime mismatch for zlib/i,
  );
  manifest.bundle_runtime.platform = 'linux';
  assert.throws(() => validatePerformanceBudgetManifest(manifest), /Bundle runtime platform/);
});

test('rejects unreviewed baseline metadata', () => {
  const unreviewed = manifestFor(1000);
  unreviewed.baseline_review.owner_role = 'somebody';
  assert.throws(() => validatePerformanceBudgetManifest(unreviewed), /allowed owner role/);
});
