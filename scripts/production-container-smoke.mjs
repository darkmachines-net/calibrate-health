/** @file Builds and checks the production container against owned disposable runtime dependencies. */

import assert from 'node:assert/strict';
import process from 'node:process';

const baseUrl = new URL(process.argv[2] ?? process.env.CALIBRATE_CONTAINER_URL ?? 'http://127.0.0.1:3000');
const ENTRY_BUNDLE_PATTERN = /src=["'](\/_expo\/static\/js\/web\/index-[a-f0-9]+\.js)["']/;

async function get(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), { signal: AbortSignal.timeout(10_000) });
  return { response, body: await response.text() };
}

const ready = await get('/api/v1/readyz');
assert.equal(ready.response.status, 200, `Container readiness failed: ${ready.body}`);

const today = await get('/today');
assert.equal(today.response.status, 200, 'Expo /today route must be served.');
assert.match(today.response.headers.get('content-type') ?? '', /^text\/html\b/);
assert.equal(today.response.headers.get('cache-control'), 'no-cache');
const entryBundle = today.body.match(ENTRY_BUNDLE_PATTERN)?.[1];
assert.ok(entryBundle, 'Production HTML must load an Expo hashed entry bundle.');
assert.doesNotMatch(today.body, /\/assets\/index-[^"']+\.js/, 'Release image must not serve the Vite entry bundle.');

const bundle = await get(entryBundle);
assert.equal(bundle.response.status, 200, 'Expo entry bundle must be reachable.');
assert.equal(bundle.response.headers.get('cache-control'), 'public, max-age=31536000, immutable');

const manifest = await get('/manifest.webmanifest');
assert.equal(manifest.response.status, 200, 'Expo install manifest must be reachable.');
assert.equal(manifest.response.headers.get('cache-control'), 'no-cache');
assert.equal(JSON.parse(manifest.body).display, 'standalone');

const serviceWorker = await get('/sw.js');
assert.equal(serviceWorker.response.status, 200, 'Expo service worker must be reachable.');
assert.equal(serviceWorker.response.headers.get('cache-control'), 'no-cache');
assert.match(serviceWorker.body, /calibrate-expo-web-/);

const missingApi = await get('/api/v1/container-smoke-missing');
assert.equal(missingApi.response.status, 404, 'Missing API paths must remain backend 404s.');
assert.doesNotMatch(missingApi.body, ENTRY_BUNDLE_PATTERN, 'Frontend fallback must not mask missing API paths.');

console.log(`PASS production container serves Expo web and backend boundaries at ${baseUrl.origin}.`);
