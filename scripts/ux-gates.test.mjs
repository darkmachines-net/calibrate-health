import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  UX_ACCESSIBILITY_PROJECTS,
  UX_ACCESSIBILITY_SPEC,
  UX_PLAYWRIGHT_CONFIG,
  UX_SNAPSHOT_APPROVAL_ENV,
  UX_VISUAL_SPEC,
  createUxGateInvocation,
  parseUxGateMode,
} from './ux-gates.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('selects the UX config and the bounded accessibility project', () => {
  const invocation = createUxGateInvocation('a11y', {});
  assert.equal(invocation.environment.CALIBRATE_PLAYWRIGHT_CONFIG, UX_PLAYWRIGHT_CONFIG);
  assert.ok(invocation.args.includes(UX_ACCESSIBILITY_SPEC));
  assert.deepEqual(
    invocation.args.filter((argument) => argument.startsWith('--project=')),
    UX_ACCESSIBILITY_PROJECTS.map((project) => `--project=${project}`),
  );
  assert.ok(!invocation.args.includes(UX_VISUAL_SPEC));
  assert.equal(invocation.updateSnapshots, false);
});

test('runs the visual file across the projects selected by the UX config', () => {
  const invocation = createUxGateInvocation('visual', {});
  assert.ok(invocation.args.includes(UX_VISUAL_SPEC));
  assert.ok(!invocation.args.includes(UX_ACCESSIBILITY_SPEC));
  assert.equal(invocation.args.some((argument) => argument.startsWith('--project=')), false);
});

test('combined UX validation uses one wrapper invocation for both suites', () => {
  const invocation = createUxGateInvocation('all', {});
  assert.ok(invocation.args[0].endsWith(path.join('scripts', 'expo-web-playwright.mjs')));
  assert.ok(invocation.args.includes(UX_ACCESSIBILITY_SPEC));
  assert.ok(invocation.args.includes(UX_VISUAL_SPEC));
  assert.equal(invocation.args.some((argument) => argument.includes('update-snapshots')), false);
});

test('snapshot updates require an exact explicit approval', () => {
  assert.throws(
    () => createUxGateInvocation('update-snapshots', {}),
    new RegExp(`${UX_SNAPSHOT_APPROVAL_ENV}=1`),
  );
  assert.throws(
    () => createUxGateInvocation('update-snapshots', { [UX_SNAPSHOT_APPROVAL_ENV]: 'true' }),
    new RegExp(`${UX_SNAPSHOT_APPROVAL_ENV}=1`),
  );
  const invocation = createUxGateInvocation('update-snapshots', {
    [UX_SNAPSHOT_APPROVAL_ENV]: '1',
  });
  assert.ok(invocation.args.includes('--update-snapshots=all'));
  assert.equal(invocation.updateSnapshots, true);
});

test('rejects missing modes and arbitrary Playwright passthrough arguments', () => {
  assert.throws(() => parseUxGateMode([]), /Usage:/);
  assert.throws(() => parseUxGateMode(['all', '--update-snapshots']), /Usage:/);
  assert.equal(parseUxGateMode(['all']), 'all');
});

test('root scripts expose only one guarded snapshot-update command', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const uxScripts = Object.entries(packageJson.scripts).filter(([name]) => name.startsWith('test:ux'));
  assert.deepEqual(Object.fromEntries(uxScripts), {
    'test:ux:a11y': 'node scripts/ux-gates.mjs a11y',
    'test:ux:visual': 'node scripts/ux-gates.mjs visual',
    'test:ux': 'node scripts/ux-gates.mjs all',
    'test:ux:update-snapshots': 'node scripts/ux-gates.mjs update-snapshots',
  });
  for (const [name, command] of uxScripts) {
    if (name === 'test:ux:update-snapshots') continue;
    assert.doesNotMatch(command, /update-snapshots/);
  }
});

test('local CI replaces the standalone web build with the blocking UX build and gate', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'dev-env.mjs'), 'utf8');
  const expoBlock = source.match(/await timed\("Build Expo web"[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
  assert.match(
    expoBlock,
    /process\.platform === "win32" \? "test:ux" : "test:ux:a11y"/,
  );
  assert.match(expoBlock, /test:expo-web:release/);
  assert.doesNotMatch(expoBlock, /build:expo-web/);
});

test('host setup provisions lock-pinned Chromium through the repository Playwright CLI', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'dev-env.mjs'), 'utf8');
  assert.match(
    source,
    /playwrightCli = path\.join\(repoRoot, "node_modules", "@playwright", "test", "cli\.js"\)/,
  );
  assert.match(source, /"node_modules\/@playwright\/test\/cli\.js"/);
  assert.match(
    source,
    /run\(process\.execPath, \[playwrightCli, "install", "chromium"\]\)/,
  );

  const setupStart = source.indexOf('async function setupHost()');
  const dependenciesIndex = source.indexOf('await ensureDependencies()', setupStart);
  const chromiumIndex = source.indexOf('await ensurePlaywrightChromium()', setupStart);
  assert.ok(setupStart >= 0);
  assert.ok(dependenciesIndex > setupStart);
  assert.ok(chromiumIndex > dependenciesIndex);
  assert.match(source, /async function ci\(\) \{\s+await setupHost\(\);/);
});
test('the Playwright wrapper accepts only reviewed repository configs', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'expo-web-playwright.mjs'), 'utf8');
  assert.match(source, /CALIBRATE_PLAYWRIGHT_CONFIG/);
  assert.match(source, /playwright\.ux\.config\.ts/);
  assert.match(source, /Unsupported Playwright config/);
  assert.match(source, /CALIBRATE_APPROVE_UX_SNAPSHOTS/);
  assert.match(source, /requestsSnapshotUpdate/);
});
test('the Playwright wrapper preserves the mobile web prebuild lifecycle', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'expo-web-playwright.mjs'), 'utf8');
  assert.match(source, /resolveNpmCli\(\), '--prefix', mobileDir, 'run', 'build:web'/);
  assert.doesNotMatch(source, /scripts', 'expo-web-build\.mjs/);
});

test('the legacy exported-web runner is read-only and excludes config-owned suites', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'playwright.expo-web.config.ts'), 'utf8');
  assert.ok(source.includes("updateSnapshots: 'none'"));
  assert.ok(source.includes('/launch-22-(?:accessibility|visual)\\.spec\\.ts/'));
  assert.ok(source.includes("process.env.CALIBRATE_INCLUDE_DATA_STATE_MATRIX === '1'"));
  assert.ok(source.includes('/launch-24-data-state-matrix\\.spec\\.ts/'));
});

test('the wrapper opts into the separately hosted data-state matrix only when named explicitly', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'expo-web-playwright.mjs'), 'utf8');
  assert.match(source, /DATA_STATE_MATRIX_SPEC = path\.normalize/);
  assert.match(source, /path\.normalize\(argument\) === DATA_STATE_MATRIX_SPEC/);
  assert.match(source, /CALIBRATE_INCLUDE_DATA_STATE_MATRIX: dataStateMatrixRequested \? '1' : '0'/);
});

test('documentation screenshots require explicit evidence capture', () => {
  for (const filename of ['adaptive-forms.spec.ts', 'nested-route-stacks.spec.ts']) {
    const source = fs.readFileSync(path.join(repositoryRoot, 'e2e', 'expo-web', filename), 'utf8');
    const optIn = "if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;";
    assert.ok(source.includes(optIn), filename + ' must require ' + optIn);
    assert.ok(source.indexOf(optIn) < source.indexOf('page.screenshot('));
  }
});
