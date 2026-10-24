/** @file Regression coverage for expo web release: accepts a clean Expo web static artifact. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { enhanceExpoWebServiceWorker, inspectExpoWebExport } from './expo-web-release.mjs';

const LANDING_METADATA = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'shared', 'webRouteMetadata.json'), 'utf8'),
).landing;

const SERVICE_WORKER_TEMPLATE = `
const SHELL_CACHE_PREFIX = 'calibrate-expo-web-shell-';
const USER_CACHE_PREFIX = 'calibrate-expo-web-user-';
const CACHE_NAME = \`\${SHELL_CACHE_PREFIX}v2\`;
const APP_SHELL = ['/index.html'];
function isBackendPath(pathname) { return /^\\/(?:api|auth)(?:\\/|$)/.test(pathname); }
function isVersionedStaticAsset(pathname) { return /^\\/_expo\\/static\\/js\\/web\\/index-[a-f0-9]+\\.js$/.test(pathname); }
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || isBackendPath(url.pathname)) return;
  if (!isVersionedStaticAsset(url.pathname)) return;
  event.respondWith(fetch(event.request));
});
`;

function landingHead(overrides = '') {
  return [
    `<title>${LANDING_METADATA.title}</title>`,
    '<meta name="theme-color" content="#2E7D32">',
    `<meta name="description" content="${LANDING_METADATA.description}">`,
    `<meta name="robots" content="${LANDING_METADATA.robots}">`,
    `<link rel="canonical" href="${LANDING_METADATA.canonicalPath}">`,
    '<link rel="manifest" href="/manifest.webmanifest">',
    overrides,
  ].join('');
}

function createFixture({ includeStaleBundle = false, missingEntry = false } = {}) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-expo-web-'));
  const bundleDir = path.join(distDir, '_expo', 'static', 'js', 'web');
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'metadata.json'), JSON.stringify({ version: 0, bundler: 'metro' }));
  fs.writeFileSync(path.join(distDir, 'manifest.webmanifest'), JSON.stringify({
    id: './',
    name: 'Calibrate Health',
    short_name: 'Calibrate',
    start_url: './',
    scope: './',
    display: 'standalone',
    icons: [
      { src: './calibrate-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './calibrate-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: './calibrate-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: './calibrate-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  }));
  fs.writeFileSync(path.join(distDir, 'calibrate-icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  for (const fileName of ['calibrate-icon-192.png', 'calibrate-icon-512.png', 'calibrate-icon-maskable-512.png']) {
    fs.writeFileSync(path.join(distDir, fileName), 'png');
  }
  fs.writeFileSync(path.join(distDir, 'sw.js'), SERVICE_WORKER_TEMPLATE);
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    `<!doctype html><head>${landingHead()}</head><body><div id="root"></div><script src="/_expo/static/js/web/index-a1b2c3.js" defer></script></body>`,
  );
  if (!missingEntry) fs.writeFileSync(path.join(bundleDir, 'index-a1b2c3.js'), 'console.log("calibrate");');
  if (includeStaleBundle) fs.writeFileSync(path.join(bundleDir, 'index-deadbeef.js'), 'console.log("stale");');
  enhanceExpoWebServiceWorker(distDir);
  return distDir;
}

test('accepts a clean Expo web static artifact', (t) => {
  const distDir = createFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));

  assert.deepEqual(inspectExpoWebExport(distDir), {
    distDir,
    entryBundle: '_expo/static/js/web/index-a1b2c3.js',
    bundleCount: 1,
    assetCount: 2,
    precacheCount: 7,
    exportMode: 'single-page',
  });
});

test('accepts Metro deferred bundles referenced by the HTML entry bundle', (t) => {
  const distDir = createFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  const bundleDir = path.join(distDir, '_expo', 'static', 'js', 'web');
  fs.writeFileSync(path.join(bundleDir, 'index-a1b2c3.js'), '__d(function(){},1,{paths:{"2":"/_expo/static/js/web/index-feed1234.js"}});');
  fs.writeFileSync(path.join(bundleDir, 'index-feed1234.js'), '__d(function(){},2,[]);');
  enhanceExpoWebServiceWorker(distDir);
  assert.equal(inspectExpoWebExport(distDir).bundleCount, 2);
});

test('rejects missing HTML-linked assets', (t) => {
  const distDir = createFixture({ missingEntry: true });
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  assert.throws(() => inspectExpoWebExport(distDir), /missing asset/);
});

test('does not mistake extensionless application links for static assets', (t) => {
  const distDir = createFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.appendFileSync(path.join(distDir, 'index.html'), '<a href="/login">Sign in</a>');
  enhanceExpoWebServiceWorker(distDir);
  assert.equal(inspectExpoWebExport(distDir).assetCount, 2);
});

test('rejects a root document title that differs from centralized landing metadata', (t) => {
  const distDir = createFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  const indexPath = path.join(distDir, 'index.html');
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace(LANDING_METADATA.title, 'calibrate'));
  enhanceExpoWebServiceWorker(distDir);
  assert.throws(() => inspectExpoWebExport(distDir), /landing metadata contract/);
});

test('rejects duplicate descriptions and Apple-specific installed-app claims', (t) => {
  const distDir = createFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  const indexPath = path.join(distDir, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  fs.writeFileSync(indexPath, html.replace('</head>', `<meta name="description" content="${LANDING_METADATA.description}"></head>`));
  enhanceExpoWebServiceWorker(distDir);
  assert.throws(() => inspectExpoWebExport(distDir), /exactly one description/);

  fs.writeFileSync(indexPath, html.replace('</head>', '<meta name="apple-mobile-web-app-capable" content="yes"></head>'));
  enhanceExpoWebServiceWorker(distDir);
  assert.throws(() => inspectExpoWebExport(distDir), /Apple-specific/);
});

test('rejects stale hashed entry bundles left by an earlier export', (t) => {
  const distDir = createFixture({ includeStaleBundle: true });
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  assert.throws(() => inspectExpoWebExport(distDir), /stale or unreferenced entry bundles/);
});

test('service-worker enhancement is stable, scoped, and changes with artifact content', (t) => {
  const distDir = createFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(distDir, 'privacy.html'), '<!doctype html><title>Privacy</title>');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'assets', 'Ionicons.abcdef123456.ttf'), 'synthetic font');
  const first = enhanceExpoWebServiceWorker(distDir);
  const second = enhanceExpoWebServiceWorker(distDir);
  assert.equal(second.cacheVersion, first.cacheVersion);
  assert.ok(first.precachePaths.includes('/index.html'));
  assert.ok(first.precachePaths.includes('/privacy.html'));
  assert.ok(first.precachePaths.includes('/assets/Ionicons.abcdef123456.ttf'));
  const generatedWorker = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf8');
  assert.match(generatedWorker, /const CACHE_NAME = SHELL_CACHE_PREFIX \+ '[a-f0-9]{12}';/);
  assert.doesNotMatch(generatedWorker, /\$\{CACHE_PREFIX\}/);

  fs.appendFileSync(path.join(distDir, '_expo', 'static', 'js', 'web', 'index-a1b2c3.js'), '\n// update');
  const changed = enhanceExpoWebServiceWorker(distDir);
  assert.notEqual(changed.cacheVersion, first.cacheVersion);
  assert.equal(inspectExpoWebExport(distDir).precacheCount, 9);
});

test('rejects a release artifact missing required PWA files', (t) => {
  const distDir = createFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.rmSync(path.join(distDir, 'manifest.webmanifest'));
  assert.throws(() => inspectExpoWebExport(distDir), /missing manifest\.webmanifest/);
});

test('rejects a service worker that can intercept backend traffic', (t) => {
  const distDir = createFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  const swPath = path.join(distDir, 'sw.js');
  fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replace('api|auth', 'assets'));
  assert.throws(() => inspectExpoWebExport(distDir), /explicitly bypass \/api and \/auth/);
});

test('accepts Expo Router static-route exports without legacy metadata', (t) => {
  const distDir = createFixture();
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.rmSync(path.join(distDir, 'metadata.json'));
  for (const route of ['login.html', 'register.html', 'settings.html']) {
    fs.writeFileSync(path.join(distDir, route), '<!doctype html><title>private route</title>');
  }
  enhanceExpoWebServiceWorker(distDir);
  assert.equal(inspectExpoWebExport(distDir).exportMode, 'static-routes');
});
