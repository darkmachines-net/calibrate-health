/** @file Dependency-free PR check selection from the complete Git diff; release/manual policy stays in workflows. */
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const RELEASE_MIRRORS = new Set([
  'backend/package-lock.json', 'backend/package.json', 'backend/openapi/v1.yaml',
  'package-lock.json', 'package.json', 'packages/api-client/src/generated/v1.ts',
  'shared/client-diagnostic-versions.json', 'shared/release.json',
  'mobile/package.json', 'mobile/app.json', 'mobile/modules/wear-pairing/package.json',
  'mobile/modules/wear-pairing/android/build.gradle', 'wear/app/build.gradle.kts',
]);
const DEPENDENCY_FILES = new Set([
  'package.json', 'package-lock.json', 'mobile/package.json',
  'shared/package.json', 'packages/api-client/package.json',
]);
const NATIVE_ASSETS = new Set([
  'mobile/assets/icon.png', 'mobile/assets/icon-ios.png',
  'mobile/assets/adaptive-icon.png', 'mobile/assets/notification-icon.png',
]);

/** Resolve npm's nearest installed package, including hoisted and nested peer dependencies. */
function resolveDependency(packages, owner, name) {
  let scope = owner;
  while (true) {
    if (scope.split('/').at(-1) !== 'node_modules') {
      const candidate = scope ? `${scope}/node_modules/${name}` : `node_modules/${name}`;
      if (packages[candidate]) return candidate;
    }
    if (!scope) return undefined;
    const marker = scope.lastIndexOf('/');
    scope = marker < 0 ? '' : scope.slice(0, marker);
  }
}

/** Project mobile's resolved production graph, retaining integrity and placement but ignoring unrelated dev tools. */
export function mobileDependencyGraph(lock) {
  if (![2, 3].includes(lock?.lockfileVersion) || !lock.packages?.mobile) {
    throw new Error('Expected a workspace npm lockfile with a mobile package.');
  }
  const packages = lock.packages;
  const selected = new Map();
  const pending = ['mobile'];
  while (pending.length) {
    const key = pending.pop();
    if (selected.has(key)) continue;
    const entry = packages[key];
    if (!entry) throw new Error(`Missing mobile dependency: ${key}`);
    // Workspace version mirrors do not change installed native code.
    const { dev: _dev, devOptional: _devOptional, devDependencies: _devDependencies,
      version: _version, license: _license, ...identity } = entry;
    if (key.includes('node_modules/') && !entry.link) identity.version = entry.version;
    selected.set(key, identity);
    if (entry.link) {
      if (!packages[entry.resolved]) throw new Error(`Unresolved workspace: ${key}`);
      pending.push(entry.resolved);
    }
    const dependencies = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies };
    for (const name of Object.keys(dependencies)) {
      const resolved = resolveDependency(packages, key, name);
      if (resolved) pending.push(resolved);
      else if (entry.dependencies?.[name] && !entry.optionalDependencies?.[name]) {
        throw new Error(`Unresolved mobile dependency: ${name}`);
      }
    }
  }
  return Object.fromEntries([...selected].sort(([a], [b]) => a.localeCompare(b)));
}

/** Keep install/prebuild behavior and native configuration, excluding package prose and unrelated npm scripts. */
function nativeManifest(manifest) {
  const fields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
    'expo', 'react-native', 'codegenConfig', 'overrides', 'resolutions', 'workspaces', 'engines', 'packageManager'];
  const result = Object.fromEntries(fields.filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
  result.scripts = Object.fromEntries(Object.entries(manifest.scripts ?? {}).filter(([key]) =>
    /^(preinstall|install|postinstall|prepare|(?:pre|post)?prebuild:(android|ios))$/.test(key)));
  return result;
}

/** Compare Git JSON inputs without installing dependencies; unreadable or unsupported graphs conservatively select native builds. */
export function nativeDependenciesChanged(readBase, readHead) {
  try {
    const read = (reader, file) => JSON.parse(reader(file));
    for (const file of DEPENDENCY_FILES) {
      if (file === 'package-lock.json') continue;
      if (!isDeepStrictEqual(nativeManifest(read(readBase, file)), nativeManifest(read(readHead, file)))) return true;
    }
    return !isDeepStrictEqual(
      mobileDependencyGraph(read(readBase, 'package-lock.json')),
      mobileDependencyGraph(read(readHead, 'package-lock.json')),
    );
  } catch {
    return true;
  }
}

/** Select affected checks from added, modified and deleted paths; callers may refine dependency changes using exact Git blobs. */
export function classifyChanges(paths, { readBase, readHead } = {}) {
  const files = paths.filter(file => !/\.(md|mdx|rst)$/.test(file));
  const any = pattern => files.some(file => pattern.test(file));
  const has = file => files.includes(file);
  const selectionChanged = any(/^scripts\/ci-changes(?:\.test)?\.mjs$/);
  const workflow = name => selectionChanged || has(`.github/workflows/${name}.yml`) ||
    (name === 'tests' && any(/^scripts\/ci-test-gate(?:\.test)?\.mjs$/));
  const testFile = file => /(^|\/)(__tests__|__mocks__|test|tests)\/|\.(test|spec)\.[^/]+$/.test(file);
  const runtime = files.filter(file => !testFile(file));
  const source = pattern => runtime.some(file => pattern.test(file));
  const workspace = any(/^(package(?:-lock)?\.json|\.npmrc|(?:mobile|shared|packages\/[^/]+)\/package\.json)$/);
  const backendDependencies = any(/^backend\/(package(?:-lock)?\.json|\.npmrc)$/);
  const shared = source(/^shared\//);
  const backendBuild = source(/^backend\/(src|prisma|scripts)\//) ||
    any(/^backend\/(prisma\.config\.ts|tsconfig(?:\.build|\.mcp-app)?\.json)$/) || backendDependencies || shared;
  const client = source(/^packages\/api-client\//);
  const mobileSource = file => /^(mobile\/(app|src|assets|modules)\/|packages\/api-client\/|shared\/)/.test(file);
  const webSource = runtime.some(file => mobileSource(file) &&
    !/\.(native|android|ios)\.[^/]+$/.test(file) && !/^mobile\/modules\/[^/]+\/(android|ios)\//.test(file));
  const nativeSource = runtime.some(file => mobileSource(file) && !/\.web\.[^/]+$/.test(file));
  const expoConfig = any(/^mobile\/(app\.config\.[cm]?[jt]s|app\.json|babel\.config\.[cm]?js|metro\.config\.[cm]?js|tsconfig\.json|index\.js)$/);
  const webBuild = webSource || expoConfig || workspace || source(/^mobile\/public\//) ||
    any(/^scripts\/(expo-cli-environment|expo-web-build|expo-web-release)\.mjs$/);
  const nativeFiles = runtime.filter(file => NATIVE_ASSETS.has(file) ||
    /^mobile\/(plugins\/|gradle\/|modules\/[^/]+\/(android\/|ios\/|[^/]+\.(podspec|json)$|(?:app\.plugin|react-native\.config)\.[cm]?js$)|android\/|ios\/)/.test(file) ||
    /^mobile\/(app\.config\.[cm]?[jt]s|app\.json|eas\.json|(?:react-native|fingerprint)\.config\.[cm]?js)$/.test(file) ||
    /^(patches\/|(?:mobile\/)?\.npmrc$|wear\/gradle\/wrapper\/gradle-wrapper\.jar$)/.test(file));
  const dependencyTouched = files.some(file => DEPENDENCY_FILES.has(file));
  const nativeDependencies = dependencyTouched && nativeDependenciesChanged(readBase, readHead);
  const androidOnly = /^(mobile\/(gradle\/|android\/|modules\/[^/]+\/android\/|assets\/(adaptive-icon|notification-icon)\.png$)|wear\/gradle\/wrapper\/gradle-wrapper\.jar$)/;
  const iosOnly = /^mobile\/(ios\/|modules\/[^/]+\/(ios\/|[^/]+\.podspec$)|assets\/icon-ios\.png$)/;
  const nativeAndroid = nativeDependencies || workflow('builds') || nativeFiles.some(file => !iosOnly.test(file));
  const nativeIos = nativeDependencies || workflow('builds') || nativeFiles.some(file => !androidOnly.test(file));
  const api = any(/^(backend\/openapi\/|packages\/api-client\/)/) || backendDependencies || workspace || shared;
  const apiContract = any(/^(backend\/openapi\/|packages\/api-client\/src\/generated\/)/) || backendDependencies || has('package.json');
  const kotlin = any(/\.(kt|kts)$/) || any(/^(tools\/kotlin-lint\/|wear\/gradle\/|wear\/gradlew|scripts\/kotlin-lint\.mjs$)/);
  const eslint = any(/\.(js|jsx|cjs|mjs|ts|tsx)$/) || workspace;
  const typeBackend = backendBuild;
  const typeShared = any(/^shared\//) || workspace;
  const typeApi = any(/^packages\/api-client\//) || shared || workspace;
  const typeMobile = any(/^mobile\/.*\.(ts|tsx|js|json)$/) || client || shared || workspace;
  const deadCode = eslint || any(/(^|\/)package(?:-lock)?\.json$|^knip\.json$|^\.github\/workflows\//);
  const database = any(/^backend\/(prisma\/|prisma\.config\.ts$|tsconfig(?:\.build)?\.json$)/) || backendDependencies ||
    source(/^backend\/src\/(config\/database(?:Utils)?\.ts$|observability\.ts$|routes\/(goals|metrics|user|imports)\.ts$|services\/(calorie|goal|watch|clientOperation|sync|import|loseItImport|metricProgress|materializedWeightTrend|weightTrend)|utils\/(date|goal|units))/) ||
    any(/^(deploy\/backup\/|scripts\/postgres-.*\.mjs$|shared\/(weightTrend|goal|calorie).*\.ts$)/);
  // The isolated App has a browser bridge and installable package outside Expo's test surface.
  const mcp = paths.some(file => /^plugins\/calibrate-health\//.test(file)) ||
    any(/^(backend\/src\/mcp\/|backend\/src\/services\/mcpProgress|backend\/scripts\/(build-mcp-app|dev-mcp-server)|backend\/test\/mcp-|e2e\/mcp-app\/|playwright\.mcp-app\.config\.ts$|scripts\/calibrate-plugin)/) ||
    backendDependencies || workspace || has('backend/tsconfig.mcp-app.json') || has('shared/designTokens.ts') ||
    has('LICENSE') || has('NOTICE') || workflow('tests');
  return {
    release_config: selectionChanged || has('release.config.json') || files.some(file => RELEASE_MIRRORS.has(file)) || any(/^(\.github\/|deploy\/|quality\/|scripts\/|wear\/)/) ||
      api || expoConfig || has('mobile/eas.json') || any(/^shared\/(release|client-diagnostic-versions)\.json$/) || has('playwright.ux.config.ts'),
    backend_build: backendBuild || workflow('builds'),
    backend: any(/^backend\//) || any(/^shared\//) || workflow('tests'),
    mobile: any(/^mobile\//) || client || shared || workspace || workflow('tests'),
    api: api || workflow('tests'),
    api_contract: apiContract || workflow('tests'),
    mcp,
    web: webBuild || workflow('builds') || any(/^(e2e\/expo-web\/(fixtures\.ts|release-smoke\.spec\.ts)|playwright\.expo-web\.config\.ts)$/) ||
      any(/^scripts\/expo-web-(playwright|static-server|release).*\.mjs$/),
    wear: any(/^wear\//) || workflow('builds'),
    native_runtime: nativeSource || expoConfig || workspace || workflow('builds') || has('scripts/xcode-uuid-compatibility.test.mjs'),
    native_package: nativeAndroid || nativeIos,
    native_android: nativeAndroid,
    native_ios: nativeIos,
    eslint: eslint || workflow('lint'),
    kotlin: kotlin || workflow('lint'),
    type_backend: typeBackend || workflow('lint'),
    type_shared: typeShared || workflow('lint'),
    type_api: typeApi || workflow('lint'),
    type_mobile: typeMobile || workflow('lint'),
    dead_code: deadCode || workflow('lint'),
    image: backendBuild || webBuild || source(/^packages\//) || workflow('container-scan') ||
      any(/^(Dockerfile\.app|\.dockerignore|scripts\/production-container-smoke\.mjs)$/),
    database: database || workflow('database-upgrade'),
    migrations: any(/^backend\/prisma\/migrations\//) || any(/^scripts\/postgres-rollback-smoke(?:\.test)?\.mjs$/) || workflow('database-upgrade'),
    non_release_mirror: paths.some(file => !RELEASE_MIRRORS.has(file)),
  };
}

/** Read a full three-dot PR diff from local history, counting both sides of renames and failing on missing history. */
export function inspectPullRequest(base, head, { cwd = process.cwd() } = {}) {
  if (![base, head].every(sha => /^[0-9a-f]{40}$/.test(sha ?? ''))) throw new Error('PR base/head must be full Git SHAs.');
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ancestor = git(['merge-base', base, head]).trim();
  const files = git(['diff', '--name-only', '--no-renames', '-z', ancestor, head, '--']).split('\0').filter(Boolean);
  return classifyChanges(files, {
    readBase: file => git(['show', `${ancestor}:${file}`]),
    readHead: file => git(['show', `${head}:${file}`]),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputs = inspectPullRequest(process.env.PR_BASE_SHA, process.env.PR_HEAD_SHA);
  const lines = Object.entries(outputs).map(([name, selected]) => `${name}=${selected}`).join('\n');
  console.log(lines);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Affected PR checks\n\n| Surface | Selected |\n| --- | --- |\n${Object.entries(outputs)
      .map(([name, selected]) => `| ${name} | ${selected} |`).join('\n')}\n`);
}
