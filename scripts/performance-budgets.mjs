import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
export const DEFAULT_PERFORMANCE_BUDGET_PATH = path.join(REPO_ROOT, 'quality', 'performance-budgets.json');
export const DEFAULT_EXPO_WEB_DIST = path.join(REPO_ROOT, 'mobile', 'dist');
export const REPRESENTATIVE_ROUTES = ['/', '/login', '/today', '/progress', '/settings'];
const EXPO_BUNDLE_PATTERN = /^_expo\/static\/js\/web\/[A-Za-z0-9][A-Za-z0-9._-]*-[a-f0-9]{8,64}\.js$/;
const DEFERRED_BUNDLE_PATTERN = /["']\/?(_expo\/static\/js\/web\/[A-Za-z0-9][A-Za-z0-9._-]*-[a-f0-9]{8,64}\.js)["']/g;
const ALLOWED_OWNER_ROLES = new Set(['release_engineer', 'service_operator', 'backend_maintainer', 'client_maintainer']);
const REQUIRED_LIMITS = Object.freeze({
  largest_contentful_paint_ms: 2500,
  cumulative_layout_shift: 0.1,
  interaction_to_next_paint_ms: 200,
  route_bundle_growth_percent: 5,
  api_recompute_regression_percent: 10,
});
const REQUIRED_BENCHMARKS = ['diagnostics_snapshot_serialization', 'weight_trend_recompute'];
export const REQUIRED_BENCHMARK_RUNTIME = Object.freeze({
  node: '24.14.0',
  v8: '13.6.233.17-node.41',
  platform: 'win32',
  arch: 'x64',
});
export const REQUIRED_BUNDLE_RUNTIME = Object.freeze({
  node: '24.14.0',
  v8: '13.6.233.17-node.41',
  zlib: '1.3.1-e00f703',
  platform: 'win32',
  arch: 'x64',
});
const REQUIRED_MANIFEST_KEYS = [
  'baseline_review',
  'benchmark_baselines',
  'benchmark_runtime',
  'bundle_runtime',
  'limits',
  'route_bundle_baselines',
  'schema_version',
];

function assertExactKeys(value, expected, label) {
  const actual = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} must contain exactly: ${required.join(', ')}.`);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read performance budget JSON ${filePath}: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
}

function routeHtmlPath(distDir, route) {
  if (route === '/') return path.join(distDir, 'index.html');
  return path.join(distDir, `${route.replace(/^\//, '')}.html`);
}

function collectHtmlEntryBundles(html) {
  const bundles = [];
  for (const match of html.matchAll(/\bsrc=["']([^"']+)["']/g)) {
    const candidate = match[1].split(/[?#]/, 1)[0].replace(/^\.?\/+/, '');
    if (EXPO_BUNDLE_PATTERN.test(candidate)) bundles.push(candidate);
  }
  return [...new Set(bundles)];
}

function collectReachableBundles(distDir, entryBundles) {
  const reachable = new Set();
  const pending = [...entryBundles];
  while (pending.length > 0) {
    const bundlePath = pending.shift();
    if (!bundlePath || reachable.has(bundlePath)) continue;
    const absolutePath = path.join(distDir, ...bundlePath.split('/'));
    if (!fs.existsSync(absolutePath)) throw new Error(`Route bundle is missing: ${bundlePath}`);
    reachable.add(bundlePath);
    const source = fs.readFileSync(absolutePath, 'utf8');
    for (const match of source.matchAll(DEFERRED_BUNDLE_PATTERN)) {
      if (!reachable.has(match[1])) pending.push(match[1]);
    }
  }
  return [...reachable].sort();
}

/** Exact level-9 gzip bytes for every JavaScript bundle reachable from representative route HTML. */
export function measureRouteBundleGraphs(distDir = DEFAULT_EXPO_WEB_DIST, routes = REPRESENTATIVE_ROUTES) {
  const resolvedDist = path.resolve(distDir);
  return Object.fromEntries(routes.map((route) => {
    const htmlPath = routeHtmlPath(resolvedDist, route);
    if (!fs.existsSync(htmlPath)) throw new Error(`Representative route export is missing: ${htmlPath}`);
    const entries = collectHtmlEntryBundles(fs.readFileSync(htmlPath, 'utf8'));
    if (entries.length !== 1) {
      throw new Error(`Representative route ${route} must reference exactly one entry bundle; found ${entries.length}.`);
    }
    const bundles = collectReachableBundles(resolvedDist, entries);
    const gzipBytes = bundles.reduce((total, bundlePath) => {
      const source = fs.readFileSync(path.join(resolvedDist, ...bundlePath.split('/')));
      return total + zlib.gzipSync(source, { level: 9 }).byteLength;
    }, 0);
    return [route, { gzip_bytes: gzipBytes, bundles }];
  }));
}

export function validatePerformanceBudgetManifest(manifest) {
  assertExactKeys(manifest, REQUIRED_MANIFEST_KEYS, 'Performance budget manifest');
  if (manifest?.schema_version !== 1) throw new Error('Performance budget manifest schema_version must be 1.');
  assertExactKeys(manifest.limits, Object.keys(REQUIRED_LIMITS), 'Performance limits');
  for (const [name, ceiling] of Object.entries(REQUIRED_LIMITS)) {
    const value = manifest.limits[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value !== ceiling) {
      throw new Error(`${name} must be the finite positive required ceiling ${ceiling}.`);
    }
  }
  assertExactKeys(manifest.benchmark_runtime, Object.keys(REQUIRED_BENCHMARK_RUNTIME), 'Benchmark runtime');
  for (const [name, expected] of Object.entries(REQUIRED_BENCHMARK_RUNTIME)) {
    if (manifest.benchmark_runtime[name] !== expected) {
      throw new Error(`Benchmark runtime ${name} must be the reviewed value ${expected}.`);
    }
  }
  assertExactKeys(manifest.bundle_runtime, Object.keys(REQUIRED_BUNDLE_RUNTIME), 'Bundle runtime');
  for (const [name, expected] of Object.entries(REQUIRED_BUNDLE_RUNTIME)) {
    if (manifest.bundle_runtime[name] !== expected) {
      throw new Error(`Bundle runtime ${name} must be the reviewed value ${expected}.`);
    }
  }
  assertExactKeys(manifest.route_bundle_baselines, REPRESENTATIVE_ROUTES, 'Route bundle baselines');
  for (const route of REPRESENTATIVE_ROUTES) {
    assertExactKeys(manifest.route_bundle_baselines[route], ['gzip_bytes'], `Route bundle baseline ${route}`);
    const gzipBytes = manifest.route_bundle_baselines[route].gzip_bytes;
    if (!Number.isInteger(gzipBytes) || gzipBytes <= 0) {
      throw new Error(`Route bundle baseline ${route} gzip_bytes must be a positive integer.`);
    }
  }
  assertExactKeys(manifest.benchmark_baselines, REQUIRED_BENCHMARKS, 'Benchmark baselines');
  for (const benchmark of REQUIRED_BENCHMARKS) {
    assertExactKeys(manifest.benchmark_baselines[benchmark], ['median_ratio_ppm'], `Benchmark baseline ${benchmark}`);
    const medianRatio = manifest.benchmark_baselines[benchmark].median_ratio_ppm;
    if (!Number.isInteger(medianRatio) || medianRatio <= 0) {
      throw new Error(`Benchmark baseline ${benchmark} median_ratio_ppm must be a positive integer.`);
    }
  }
  const review = manifest.baseline_review;
  if (
    typeof review?.reference !== 'string' || !/^[a-z0-9#._-]{3,64}$/i.test(review.reference) ||
    !ALLOWED_OWNER_ROLES.has(review?.owner_role) ||
    typeof review?.reviewed_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(review.reviewed_on) ||
    typeof review?.rationale !== 'string' || review.rationale.trim().length < 20
  ) {
    throw new Error('Performance baselines require a review reference, allowed owner role, review date, and rationale.');
  }
  return manifest;
}

export function assertBenchmarkRuntime(manifest, runtime = {
  node: process.versions.node,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
}) {
  validatePerformanceBudgetManifest(manifest);
  for (const key of Object.keys(REQUIRED_BENCHMARK_RUNTIME)) {
    if (runtime[key] !== manifest.benchmark_runtime[key]) {
      throw new Error(
        `Performance benchmark runtime mismatch for ${key}: observed ${runtime[key]}; expected ${manifest.benchmark_runtime[key]}.`,
      );
    }
  }
}

export function assertBundleRuntime(manifest, runtime = {
  node: process.versions.node,
  v8: process.versions.v8,
  zlib: process.versions.zlib,
  platform: process.platform,
  arch: process.arch,
}) {
  validatePerformanceBudgetManifest(manifest);
  for (const key of Object.keys(REQUIRED_BUNDLE_RUNTIME)) {
    if (runtime[key] !== manifest.bundle_runtime[key]) {
      throw new Error(
        `Expo bundle runtime mismatch for ${key}: observed ${runtime[key]}; expected ${manifest.bundle_runtime[key]}.`,
      );
    }
  }
}

export function evaluateRouteBundleGrowth(measured, manifest) {
  validatePerformanceBudgetManifest(manifest);
  const allowedGrowth = manifest.limits.route_bundle_growth_percent;
  const failures = [];
  for (const route of REPRESENTATIVE_ROUTES) {
    const current = measured[route]?.gzip_bytes;
    const baseline = manifest.route_bundle_baselines?.[route]?.gzip_bytes;
    if (!Number.isInteger(current) || current <= 0) failures.push(`${route}: current gzip bytes are missing`);
    if (!Number.isInteger(baseline) || baseline <= 0) failures.push(`${route}: committed gzip baseline is missing`);
    if (!Number.isInteger(current) || !Number.isInteger(baseline) || baseline <= 0) continue;
    const growthPercent = ((current - baseline) / baseline) * 100;
    if (growthPercent > allowedGrowth + Number.EPSILON) {
      failures.push(`${route}: ${current} gzip bytes is ${growthPercent.toFixed(2)}% above baseline ${baseline} (limit ${allowedGrowth}%)`);
    }
  }
  if (failures.length > 0) throw new Error(`Expo route bundle budget failed:\n${failures.join('\n')}`);
}

function parseUpdateOptions(args) {
  const value = (name) => args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  return {
    update: args.includes('--update-baseline'),
    reviewReference: value('--review-reference'),
    ownerRole: value('--owner-role'),
    reviewedOn: value('--reviewed-on'),
    rationale: value('--rationale'),
  };
}

function updateRouteBaselines(manifestPath, manifest, measured, options) {
  const next = {
    ...manifest,
    route_bundle_baselines: Object.fromEntries(
      REPRESENTATIVE_ROUTES.map((route) => [route, { gzip_bytes: measured[route].gzip_bytes }]),
    ),
    baseline_review: {
      reference: options.reviewReference,
      owner_role: options.ownerRole,
      reviewed_on: options.reviewedOn,
      rationale: options.rationale,
    },
  };
  validatePerformanceBudgetManifest(next);
  fs.writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const distOption = args.find((argument) => argument.startsWith('--dist='))?.slice('--dist='.length);
    const manifestOption = args.find((argument) => argument.startsWith('--manifest='))?.slice('--manifest='.length);
    const distDir = path.resolve(distOption || DEFAULT_EXPO_WEB_DIST);
    const manifestPath = path.resolve(manifestOption || DEFAULT_PERFORMANCE_BUDGET_PATH);
    let manifest = readJson(manifestPath);
    assertBundleRuntime(manifest);
    const measured = measureRouteBundleGraphs(distDir);
    const updateOptions = parseUpdateOptions(args);
    if (updateOptions.update) manifest = updateRouteBaselines(manifestPath, manifest, measured, updateOptions);
    evaluateRouteBundleGrowth(measured, manifest);
    for (const route of REPRESENTATIVE_ROUTES) {
      const baseline = manifest.route_bundle_baselines[route].gzip_bytes;
      console.log(`[route-bundle] ${route} ${measured[route].gzip_bytes} gzip bytes (baseline ${baseline})`);
    }
    console.log('[route-bundle] Expo route HTML may share one deferred graph; values are conservative total reachable graphs, not isolated chunk ownership.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
