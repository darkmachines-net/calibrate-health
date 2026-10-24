/** @file Regression coverage for frontend static: frontend cache policy revalidates documents and permanently caches hashed assets. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const {
  configureFrontendStaticAssets,
  frontendAssetCacheControl
} = require('../src/frontendStatic');

test('frontend cache policy revalidates documents and permanently caches hashed assets', () => {
  assert.equal(frontendAssetCacheControl('/dist/today.html'), 'no-cache');
  assert.equal(frontendAssetCacheControl('/dist/sw.js'), 'no-cache');
  assert.equal(frontendAssetCacheControl('/dist/manifest.webmanifest'), 'no-cache');
  assert.equal(
    frontendAssetCacheControl('/dist/_expo/static/js/web/index-0123456789abcdef.js'),
    'public, max-age=31536000, immutable'
  );
  assert.equal(frontendAssetCacheControl('/dist/calibrate-icon.svg'), 'public, max-age=3600');
});

test('deployed frontend serves Expo static routes without masking backend paths', async (t) => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-frontend-static-'));
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(distDir, '_expo', 'static', 'js', 'web'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>index shell</title>');
  fs.writeFileSync(path.join(distDir, 'today.html'), '<!doctype html><title>today route</title>');
  fs.writeFileSync(path.join(distDir, 'sw.js'), '// service worker');
  fs.writeFileSync(
    path.join(distDir, '_expo', 'static', 'js', 'web', 'index-0123456789abcdef.js'),
    '// bundle'
  );

  const app = express();
  configureFrontendStaticAssets(app, true, distDir);
  app.use((_request, response) => response.status(404).json({ message: 'Not found' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const staticRoute = await fetch(`${origin}/today`);
  assert.equal(staticRoute.status, 200);
  assert.match(await staticRoute.text(), /today route/);
  assert.equal(staticRoute.headers.get('cache-control'), 'no-cache');

  const fallback = await fetch(`${origin}/unknown-client-route`);
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /index shell/);
  assert.equal(fallback.headers.get('x-calibrate-spa-fallback'), '1');
  assert.equal(fallback.headers.get('cache-control'), 'no-cache');

  const api = await fetch(`${origin}/api/v1/missing`);
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { message: 'Not found' });

  const bundle = await fetch(`${origin}/_expo/static/js/web/index-0123456789abcdef.js`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});
