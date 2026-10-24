const fs = require('node:fs');
const path = require('node:path');

const release = require('../../shared/release.json');
const { computeWeightTrend } = require('../../shared/weightTrend.ts');
const { DiagnosticsRegistry } = require('../src/observability');
const { computeWeightTrendV1 } = require('../src/services/weightTrendV1');

const MANIFEST_PATH = path.resolve(__dirname, '../../quality/performance-budgets.json');
const WARMUP_SAMPLES = 3;
const MEASURED_SAMPLES = 9;
const REQUIRED_BENCHMARKS = ['diagnostics_snapshot_serialization', 'weight_trend_recompute'];
const ALLOWED_OWNER_ROLES = new Set(['release_engineer', 'service_operator', 'backend_maintainer', 'client_maintainer']);
// Retain benchmark results so the measured work cannot be optimized away.
const benchmarkSink = { value: undefined };

function buildWeightFixture() {
  const firstDay = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: 150 }, (_unused, index) => ({
    date: new Date(firstDay + index * 86_400_000),
    weight: 87 - index * 0.35 / 7 + Math.sin(index * 1.7) * 0.42 + (index % 31 === 0 ? 1.2 : 0),
  }));
}

function buildDiagnosticsFixture() {
  const registry = new DiagnosticsRegistry();
  const categories = ['auth', 'provider', 'notification', 'sync', 'frontend'];
  const operations = ['notification_delivery', 'auth_mobile_refresh', 'food_provider_request', 'health_connect_ingestion', 'weight_trend_recompute'];
  for (let index = 0; index < 250; index += 1) {
    registry.recordRequest(categories[index % categories.length], index % 29 === 0 ? 503 : 200, 8 + index % 600);
    registry.recordOperation(operations[index % operations.length], index % 37 === 0 ? 'failure' : 'success', 4 + index % 420);
  }
  registry.recordJob('reminder_scheduler', 'success', 42);
  for (let index = 0; index < 120; index += 1) {
    registry.recordClientDiagnostic({
      event: 'web_vital',
      operation: 'largest_contentful_paint',
      route: index % 2 === 0 ? 'app_shell' : 'today',
      platform: 'web',
      version: release.server.version,
      outcome: index % 11 === 0 ? 'needs_improvement' : 'good',
      duration_bucket: index % 11 === 0 ? '2_5_to_4_s' : '1_to_2_5_s',
    });
  }
  return registry;
}

function runBatch(action, iterations) {
  const started = process.hrtime.bigint();
  for (let iteration = 0; iteration < iterations; iteration += 1) benchmarkSink.value = action();
  return Number(process.hrtime.bigint() - started);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function balancedReferenceIterations(targetIterations, baselineRatioPpm) {
  if (!Number.isSafeInteger(targetIterations) || targetIterations <= 0) {
    throw new Error('Target benchmark iterations must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(baselineRatioPpm) || baselineRatioPpm <= 0) {
    throw new Error('Benchmark baseline ratio must be a positive safe integer.');
  }
  const scale = Math.max(1, Math.round(baselineRatioPpm / 1_000_000));
  const referenceIterations = targetIterations * scale;
  if (!Number.isSafeInteger(referenceIterations)) {
    throw new Error('Balanced reference iterations exceed the safe integer range.');
  }
  return referenceIterations;
}

function normalizeRatioPpm(targetNs, referenceNs, targetIterations, referenceIterations) {
  if (
    !Number.isFinite(targetNs) || targetNs <= 0 ||
    !Number.isFinite(referenceNs) || referenceNs <= 0 ||
    !Number.isSafeInteger(targetIterations) || targetIterations <= 0 ||
    !Number.isSafeInteger(referenceIterations) || referenceIterations <= 0
  ) {
    throw new Error('Benchmark durations and iteration counts must be finite and positive.');
  }
  return Math.round(
    (targetNs / targetIterations) /
    (referenceNs / referenceIterations) *
    1_000_000,
  );
}

function evaluateBenchmarkRatio(current, baseline, regressionPercent) {
  if (
    !Number.isSafeInteger(current) || current <= 0 ||
    !Number.isSafeInteger(baseline) || baseline <= 0 ||
    !Number.isFinite(regressionPercent) || regressionPercent < 0
  ) {
    throw new Error('Benchmark ratios and regression percent must be finite and non-negative.');
  }
  const allowed = Math.floor(baseline * (1 + regressionPercent / 100));
  return { allowed, exceeds: current > allowed };
}

function isConfirmedBenchmarkRegression(current, confirmation, baseline, regressionPercent) {
  return evaluateBenchmarkRatio(current, baseline, regressionPercent).exceeds &&
    evaluateBenchmarkRatio(confirmation, baseline, regressionPercent).exceeds;
}

function measureMedianRatioPpm(target, reference, targetIterations, baselineRatioPpm) {
  // Match batch duration to the reviewed ratio so both sides see comparable host scheduling and CPU scaling.
  const referenceIterations = balancedReferenceIterations(targetIterations, baselineRatioPpm);
  for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) {
    runBatch(target, targetIterations);
    runBatch(reference, referenceIterations);
  }
  const ratios = [];
  for (let sample = 0; sample < MEASURED_SAMPLES; sample += 1) {
    let targetNs;
    let referenceNs;
    if (sample % 2 === 0) {
      targetNs = runBatch(target, targetIterations);
      referenceNs = runBatch(reference, referenceIterations);
    } else {
      referenceNs = runBatch(reference, referenceIterations);
      targetNs = runBatch(target, targetIterations);
    }
    ratios.push(normalizeRatioPpm(targetNs, referenceNs, targetIterations, referenceIterations));
  }
  return median(ratios);
}

function measureBenchmarks(manifest) {
  const observations = buildWeightFixture();
  const trendOptions = {
    calibrationWindow: {
      startDate: observations.at(-29).date,
      endDate: observations.at(-1).date,
    },
  };
  const registry = buildDiagnosticsFixture();
  const frozenSnapshot = registry.snapshot();
  return {
    diagnostics_snapshot_serialization: {
      median_ratio_ppm: measureMedianRatioPpm(
        () => JSON.stringify(registry.snapshot()),
        () => JSON.stringify(frozenSnapshot),
        2000,
        manifest.benchmark_baselines.diagnostics_snapshot_serialization.median_ratio_ppm,
      ),
    },
    weight_trend_recompute: {
      median_ratio_ppm: measureMedianRatioPpm(
        () => computeWeightTrend(observations, trendOptions),
        () => computeWeightTrendV1(observations),
        40,
        manifest.benchmark_baselines.weight_trend_recompute.median_ratio_ppm,
      ),
    },
  };
}

function parseOptions(args) {
  const value = (name) => args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  return {
    update: args.includes('--update-baseline'),
    reference: value('--review-reference'),
    ownerRole: value('--owner-role'),
    reviewedOn: value('--reviewed-on'),
    rationale: value('--rationale'),
  };
}

function assertReview(options) {
  if (
    typeof options.reference !== 'string' || !/^[a-z0-9#._-]{3,64}$/i.test(options.reference) ||
    !ALLOWED_OWNER_ROLES.has(options.ownerRole) ||
    typeof options.reviewedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(options.reviewedOn) ||
    typeof options.rationale !== 'string' || options.rationale.trim().length < 20
  ) {
    throw new Error('Baseline update requires review reference, allowed owner role, YYYY-MM-DD date, and rationale.');
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const { assertBenchmarkRuntime, validatePerformanceBudgetManifest } = await import('../../scripts/performance-budgets.mjs');
  validatePerformanceBudgetManifest(manifest);
  assertBenchmarkRuntime(manifest);
  const measured = measureBenchmarks(manifest);
  if (options.update) {
    assertReview(options);
    manifest.benchmark_baselines = measured;
    manifest.baseline_review = {
      reference: options.reference,
      owner_role: options.ownerRole,
      reviewed_on: options.reviewedOn,
      rationale: options.rationale,
    };
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('[performance] Updated reviewed benchmark baselines. Run the route baseline updater before review.');
    return;
  }

  const initialEvaluations = Object.fromEntries(REQUIRED_BENCHMARKS.map((name) => [
    name,
    evaluateBenchmarkRatio(
      measured[name].median_ratio_ppm,
      manifest.benchmark_baselines[name].median_ratio_ppm,
      manifest.limits.api_recompute_regression_percent,
    ),
  ]));
  const confirmation = Object.values(initialEvaluations).some(({ exceeds }) => exceeds)
    ? measureBenchmarks(manifest)
    : null;
  const failures = [];
  for (const name of REQUIRED_BENCHMARKS) {
    const current = measured[name].median_ratio_ppm;
    const baseline = manifest.benchmark_baselines[name].median_ratio_ppm;
    const evaluation = initialEvaluations[name];
    const { allowed } = evaluation;
    console.log(`[performance] ${name}: median ratio ${current} ppm (baseline ${baseline}, limit ${allowed})`);
    if (!evaluation.exceeds) continue;
    const confirmedCurrent = confirmation[name].median_ratio_ppm;
    console.log(`[performance] ${name}: confirmation median ratio ${confirmedCurrent} ppm (limit ${allowed})`);
    if (isConfirmedBenchmarkRegression(
      current,
      confirmedCurrent,
      baseline,
      manifest.limits.api_recompute_regression_percent,
    )) {
      failures.push(`${name}: ${current} ppm and confirmation ${confirmedCurrent} ppm exceed ${allowed} ppm`);
    }
  }
  if (failures.length > 0) throw new Error(`API/recompute performance budget failed:\n${failures.join('\n')}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  balancedReferenceIterations,
  evaluateBenchmarkRatio,
  isConfirmedBenchmarkRegression,
  normalizeRatioPpm,
};
