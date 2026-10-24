/** @file Regression coverage for expo web static server: resolves files and extensionless routes through the SPA shell. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExpoWebStaticServer, resolveExpoWebRequest } from './expo-web-static-server.mjs';

function createFixture(t) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-expo-server-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>calibrate</title>');
  fs.writeFileSync(path.join(distDir, 'assets', 'app-deadbeef.js'), 'console.log("calibrate");');
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  return distDir;
}

test('resolves files and extensionless routes through the SPA shell', (t) => {
  const distDir = createFixture(t);
  assert.deepEqual(resolveExpoWebRequest(distDir, '/register'), {
    status: 200,
    filePath: path.join(distDir, 'index.html'),
    spaFallback: true,
  });
  assert.deepEqual(resolveExpoWebRequest(distDir, '/assets/app-deadbeef.js'), {
    status: 200,
    filePath: path.join(distDir, 'assets', 'app-deadbeef.js'),
    spaFallback: false,
  });
});

test('prefers a generated static route over the SPA fallback', (t) => {
  const distDir = createFixture(t);
  const routeFile = path.join(distDir, 'register.html');
  fs.writeFileSync(routeFile, '<!doctype html><title>Register</title>');

  assert.deepEqual(resolveExpoWebRequest(distDir, '/register'), {
    status: 200,
    filePath: routeFile,
    spaFallback: false,
  });
});

test('uses the generated not-found document for unknown static routes', (t) => {
  const distDir = createFixture(t);
  const notFoundFile = path.join(distDir, '+not-found.html');
  fs.writeFileSync(notFoundFile, '<!doctype html><title>Not found</title>');

  assert.deepEqual(resolveExpoWebRequest(distDir, '/missing-route'), {
    status: 200,
    filePath: notFoundFile,
    spaFallback: true,
  });
});

test('does not let SPA fallback mask backend, missing static, or traversal requests', (t) => {
  const distDir = createFixture(t);
  assert.deepEqual(resolveExpoWebRequest(distDir, '/auth/me'), { status: 404 });
  assert.deepEqual(resolveExpoWebRequest(distDir, '/api/v1/foods'), { status: 404 });
  assert.deepEqual(resolveExpoWebRequest(distDir, '/missing.js'), { status: 404 });
  assert.deepEqual(resolveExpoWebRequest(distDir, '/%2e%2e/secret'), { status: 400 });
});

test('serves deep links with fallback and production cache headers', async (t) => {
  const distDir = createFixture(t);
  const server = createExpoWebStaticServer({ distDir });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseURL = `http://127.0.0.1:${address.port}`;

  const routeResponse = await fetch(`${baseURL}/settings`);
  assert.equal(routeResponse.status, 200);
  assert.equal(routeResponse.headers.get('x-calibrate-spa-fallback'), '1');
  assert.equal(routeResponse.headers.get('cache-control'), 'no-cache');

  const assetResponse = await fetch(`${baseURL}/assets/app-deadbeef.js`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  assert.equal((await fetch(`${baseURL}/auth/me`)).status, 404);
});
