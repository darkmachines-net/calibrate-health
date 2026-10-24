/** @file Expo export postprocessing, service-worker manifest generation, and production web release validation. */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROUTE_METADATA = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, '..', 'shared', 'webRouteMetadata.json'), 'utf8'));
const LANDING_METADATA = WEB_ROUTE_METADATA.landing;
const DEFAULT_EXPO_WEB_DIST = path.join(SCRIPT_DIR, '..', 'mobile', 'dist');
const ENTRY_BUNDLE_PATTERN = /^_expo\/static\/js\/web\/index-[a-f0-9]+\.js$/;
const PWA_FILES = ['manifest.webmanifest', 'sw.js', 'calibrate-icon.svg', 'calibrate-icon-192.png', 'calibrate-icon-512.png', 'calibrate-icon-maskable-512.png'];
const PRECACHE_SHELL_FILES = PWA_FILES.filter((fileName) => fileName !== 'sw.js');
const VERSIONED_STATIC_ASSET_PATTERN = /^(?:_expo\/static\/(?:js|css)\/.+-[a-f0-9]{6,}\.(?:js|css)|assets\/.+[.-][a-f0-9]{6,}\.[a-z0-9]+)$/i;

function readRequiredFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Expo web export is missing ${label}: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function collectHtmlAssetPaths(html) {
  const paths = [];
  const attributePattern = /\b(src|href)=["']([^"']+)["']/g;
  for (const match of html.matchAll(attributePattern)) {
    const [, attribute, value] = match;
    if (!value || /^(?:[a-z]+:|\/\/|#|data:)/i.test(value)) continue;
    const pathname = value.split(/[?#]/, 1)[0];
    // Extensionless hrefs are application routes, not deployable files.
    if (attribute === 'href' && path.posix.extname(pathname) === '') continue;
    // Expo emits root-relative assets so deep-link fallback pages resolve the same bundle as `/`.
    paths.push(pathname.replace(/^\.?\/+/, ''));
  }
  return [...new Set(paths)];
}

function listEntryBundles(distDir) {
  const bundleDir = path.join(distDir, '_expo', 'static', 'js', 'web');
  if (!fs.existsSync(bundleDir)) return [];
  return fs.readdirSync(bundleDir)
    .filter((name) => /^index-[a-f0-9]+\.js$/.test(name))
    .map((name) => `_expo/static/js/web/${name}`)
    .sort();
}

function collectReachableEntryBundles(distDir, roots) {
  const reachable = new Set();
  const pending = [...roots];
  const deferredBundlePattern = /["']\/?(_expo\/static\/js\/web\/index-[a-f0-9]+\.js)["']/g;
  while (pending.length > 0) {
    const bundlePath = pending.shift();
    if (!bundlePath || reachable.has(bundlePath)) continue;
    reachable.add(bundlePath);
    const source = readRequiredFile(path.join(distDir, bundlePath), `bundle ${bundlePath}`);
    for (const match of source.matchAll(deferredBundlePattern)) {
      const deferredPath = match[1];
      if (!reachable.has(deferredPath)) pending.push(deferredPath);
    }
  }
  return [...reachable].sort();
}

function listFiles(rootDir, relativeDir = '') {
  const directory = path.join(rootDir, relativeDir);
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDir.replaceAll(path.sep, '/'), entry.name);
      return entry.isDirectory() ? listFiles(rootDir, relativePath) : [relativePath];
    })
    .sort();
}

function expectedPrecachePaths(distDir) {
  return [
    '/index.html',
    ...listFiles(distDir)
      .filter((filePath) => filePath !== 'index.html' && (filePath.endsWith('.html') || PRECACHE_SHELL_FILES.includes(filePath) || VERSIONED_STATIC_ASSET_PATTERN.test(filePath)))
      .map((filePath) => `/${filePath}`),
  ];
}

function parseAppShell(serviceWorker, swPath) {
  const match = serviceWorker.match(/const APP_SHELL = (\[[\s\S]*?\]);/);
  if (!match) throw new Error(`Expo web service worker has no static APP_SHELL list: ${swPath}`);
  try {
    const appShell = JSON.parse(match[1]);
    if (!Array.isArray(appShell) || appShell.some((entry) => typeof entry !== 'string')) throw new Error();
    return appShell;
  } catch {
    throw new Error(`Expo web service worker APP_SHELL is not a JSON string array: ${swPath}`);
  }
}

/** Replace the source service worker's placeholder shell with a content-versioned export manifest. */
export function enhanceExpoWebServiceWorker(distDir = DEFAULT_EXPO_WEB_DIST) {
  const resolvedDist = path.resolve(distDir);
  const swPath = path.join(resolvedDist, 'sw.js');
  const source = readRequiredFile(swPath, 'sw.js');
  const template = source
    .replace(/const CACHE_NAME = [^;]+;/, "const CACHE_NAME = SHELL_CACHE_PREFIX + 'v2';")
    .replace(/const APP_SHELL = \[[\s\S]*?\];/, 'const APP_SHELL = [];');
  if (template === source && !source.includes('SHELL_CACHE_PREFIX')) {
    throw new Error('Expo web service worker template is missing replaceable CACHE_NAME or APP_SHELL constants.');
  }
  const precachePaths = expectedPrecachePaths(resolvedDist);
  const digest = crypto.createHash('sha256');
  digest.update(template);
  for (const assetPath of precachePaths) {
    const filePath = path.join(resolvedDist, assetPath.slice(1));
    digest.update(assetPath);
    digest.update(fs.readFileSync(filePath));
  }
  const cacheVersion = digest.digest('hex').slice(0, 12);
  const cacheDeclaration = "const CACHE_NAME = SHELL_CACHE_PREFIX + '" + cacheVersion + "';";
  const shellDeclaration = `const APP_SHELL = ${JSON.stringify(precachePaths, null, 2)};`;
  const withCacheVersion = template.replace(/const CACHE_NAME = [^;]+;/, cacheDeclaration);
  const enhanced = withCacheVersion.replace(/const APP_SHELL = \[[\s\S]*?\];/, shellDeclaration);
  if (withCacheVersion === template || enhanced === withCacheVersion) {
    throw new Error('Expo web service worker template is missing replaceable CACHE_NAME or APP_SHELL constants.');
  }
  fs.writeFileSync(swPath, enhanced);
  return { cacheVersion, precachePaths };
}

/** Validate the deployable Expo static artifact, including stale entry-bundle cleanup. */
export function inspectExpoWebExport(distDir = DEFAULT_EXPO_WEB_DIST) {
  const resolvedDist = path.resolve(distDir);
  const indexPath = path.join(resolvedDist, 'index.html');
  const metadataPath = path.join(resolvedDist, 'metadata.json');
  const html = readRequiredFile(indexPath, 'index.html');
  const title = html.match(/<title(?:\s[^>]*)?>([^<]+)<\/title>/i)?.[1]?.trim();
  if (title !== LANDING_METADATA.title) {
    throw new Error(`Expo web index title must match the landing metadata contract "${LANDING_METADATA.title}"; received ${title || 'empty'}.`);
  }
  const descriptionValues = [...html.matchAll(/<meta\b[^>]*\bname="description"[^>]*\bcontent="([^"]+)"[^>]*>/gi)].map((match) => match[1].trim());
  if (descriptionValues.length !== 1 || descriptionValues[0] !== LANDING_METADATA.description) {
    throw new Error('Expo web index must contain exactly one description matching the landing metadata contract.');
  }
  const robotsValues = [...html.matchAll(/<meta\b[^>]*\bname="robots"[^>]*\bcontent="([^"]+)"[^>]*>/gi)].map((match) => match[1].trim());
  if (robotsValues.length !== 1 || robotsValues[0] !== LANDING_METADATA.robots) {
    throw new Error('Expo web index robots metadata must match the landing metadata contract.');
  }
  const canonicalValues = [...html.matchAll(/<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]+)"[^>]*>/gi)].map((match) => match[1].trim());
  if (canonicalValues.length !== 1 || canonicalValues[0] !== LANDING_METADATA.canonicalPath) {
    throw new Error('Expo web index canonical link must match the landing metadata contract.');
  }
  if (/<meta\b[^>]*\bname="apple-mobile-web-app-/i.test(html)) {
    throw new Error('Expo web index must not claim Apple-specific installed-app support.');
  }
  if (!/<link\b[^>]*\brel="manifest"[^>]*\bhref="\/manifest\.webmanifest"/i.test(html) || !/<meta\b[^>]*\bname="theme-color"[^>]*\bcontent="#2E7D32"/i.test(html)) {
    throw new Error('Expo web index must retain its standards manifest and theme-color metadata.');
  }
  const hasMetadata = fs.existsSync(metadataPath);
  if (hasMetadata) {
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch {
      throw new Error(`Expo web metadata is not valid JSON: ${metadataPath}`);
    }
    if (metadata.bundler !== 'metro') {
      throw new Error(`Expo web metadata must identify the Metro bundler; received ${String(metadata.bundler)}.`);
    }
  } else {
    for (const route of ['login.html', 'register.html', 'settings.html']) {
      readRequiredFile(path.join(resolvedDist, route), `static route ${route}`);
    }
  }

  for (const fileName of PWA_FILES) readRequiredFile(path.join(resolvedDist, fileName), fileName);
  const manifestPath = path.join(resolvedDist, 'manifest.webmanifest');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Expo web manifest is not valid JSON: ${manifestPath}`);
  }
  if (manifest.start_url !== './' || manifest.scope !== './' || manifest.display !== 'standalone') {
    throw new Error('Expo web manifest must be an installable scope-relative standalone application.');
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    throw new Error('Expo web manifest must define at least one install icon.');
  }
  for (const icon of manifest.icons) {
    const iconPath = typeof icon?.src === 'string' ? icon.src.replace(/^(?:\.\/|\/)+/, '') : '';
    if (!iconPath || !fs.existsSync(path.join(resolvedDist, iconPath))) {
      throw new Error(`Expo web manifest references a missing icon: ${String(icon?.src)}.`);
    }
  }

  const assetPaths = collectHtmlAssetPaths(html);
  const entryBundles = assetPaths.filter((assetPath) => ENTRY_BUNDLE_PATTERN.test(assetPath));
  if (entryBundles.length !== 1) {
    throw new Error(`Expo web index must reference exactly one hashed entry bundle; found ${entryBundles.length}.`);
  }

  for (const assetPath of assetPaths) {
    const resolvedAsset = path.resolve(resolvedDist, assetPath);
    if (!resolvedAsset.startsWith(`${resolvedDist}${path.sep}`)) {
      throw new Error(`Expo web index references an asset outside dist: ${assetPath}`);
    }
    if (!fs.existsSync(resolvedAsset) || !fs.statSync(resolvedAsset).isFile()) {
      throw new Error(`Expo web index references a missing asset: ${assetPath}`);
    }
  }

  const emittedEntryBundles = listEntryBundles(resolvedDist);
  const reachableEntryBundles = collectReachableEntryBundles(resolvedDist, entryBundles);
  if (
    emittedEntryBundles.length !== reachableEntryBundles.length ||
    emittedEntryBundles.some((bundlePath, index) => bundlePath !== reachableEntryBundles[index])
  ) {
    throw new Error(
      `Expo web export contains stale or unreferenced entry bundles: ${emittedEntryBundles.join(', ') || 'none'}.`,
    );
  }


  const swPath = path.join(resolvedDist, 'sw.js');
  const serviceWorker = fs.readFileSync(swPath, 'utf8');
  if (!/const CACHE_NAME = SHELL_CACHE_PREFIX \+ '[a-f0-9]{12}';/.test(serviceWorker)) {
    throw new Error('Expo web service worker cache name is not content-versioned.');
  }
  if (
    !/function isBackendPath\s*\(/.test(serviceWorker) ||
    !/api\|auth/.test(serviceWorker) ||
    !/isBackendPath\(url\.pathname\)/.test(serviceWorker)
  ) {
    throw new Error('Expo web service worker must explicitly bypass /api and /auth backend traffic.');
  }
  const appShell = parseAppShell(serviceWorker, swPath);
  const expectedAppShell = expectedPrecachePaths(resolvedDist);
  if (
    appShell.length !== expectedAppShell.length ||
    expectedAppShell.some((assetPath, index) => assetPath !== appShell[index])
  ) {
    throw new Error('Expo web service worker precache does not match the generated static artifact.');
  }

  return {
    distDir: resolvedDist,
    entryBundle: entryBundles[0],
    bundleCount: reachableEntryBundles.length,
    assetCount: assetPaths.length,
    precacheCount: appShell.length,
    exportMode: hasMetadata ? 'single-page' : 'static-routes',
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = inspectExpoWebExport(process.argv[2] || DEFAULT_EXPO_WEB_DIST);
    console.log(`Expo web export valid: ${result.bundleCount} reachable bundles; ${result.assetCount} HTML-linked assets.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
