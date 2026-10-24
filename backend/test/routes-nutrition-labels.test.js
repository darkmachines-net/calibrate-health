/** @file Regression coverage for routes nutrition labels: scan endpoint authenticates, validates uploads, and aborts work on disconnect. */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Module = require('node:module');
const { once } = require('node:events');

test('scan endpoint authenticates, validates uploads, and aborts work on disconnect', { timeout: 10_000 }, async () => {
  const servicePath = require.resolve('../src/services/nutritionLabels/scan');
  const routePath = require.resolve('../src/routes/nutritionLabels');
  const previous = require.cache[servicePath];
  const settingsPath = require.resolve('../src/services/serverSettings');
  const previousSettings = require.cache[settingsPath];
  let scanningEnabled = true;
  const settingsStub = new Module(settingsPath);
  settingsStub.exports = { getServerFeatures: async () => ({ nutrition_label_scanning: scanningEnabled }) };
  settingsStub.loaded = true;
  require.cache[settingsPath] = settingsStub;
  const calls = [];
  let holdScan = false;
  let scanStarted;
  let scanAborted;
  const started = new Promise((resolve) => { scanStarted = resolve; });
  const aborted = new Promise((resolve) => { scanAborted = resolve; });
  const draft = { calories_per_serving: 160, serving_size_quantity: 0.5, serving_unit_label: 'cup (40 g)', serving_text: '1/2 cup (40 g)', warnings: [] };
  const stub = new Module(servicePath);
  stub.exports = { MAX_LABEL_IMAGE_BYTES: 32, scanNutritionLabel: async (image, signal) => {
    calls.push(image);
    if (holdScan) {
      assert.ok(signal instanceof AbortSignal);
      scanStarted();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        scanAborted();
        reject(signal.reason);
      }, { once: true }));
    }
    return draft;
  } };
  stub.loaded = true;
  require.cache[servicePath] = stub;
  delete require.cache[routePath];
  const router = require('../src/routes/nutritionLabels').default;
  if (previousSettings) require.cache[settingsPath] = previousSettings;
  else delete require.cache[settingsPath];
  if (previous) require.cache[servicePath] = previous;
  else delete require.cache[servicePath];

  const app = express();
  app.use((req, _res, next) => {
    req.isAuthenticated = () => Boolean(req.headers['x-test-user']);
    if (req.headers['x-test-user']) req.user = { id: Number(req.headers['x-test-user']) };
    next();
  });
  app.use('/api/nutrition-labels', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/api/nutrition-labels/scan';
  const upload = (bytes = 4, extra = false) => {
    const form = new FormData();
    form.append('image', new Blob([Buffer.alloc(bytes)], { type: 'image/png' }), 'label.png');
    if (extra) form.append('extra', 'unexpected');
    return form;
  };
  try {
    let response = await fetch(url, { method: 'POST', body: upload() });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
    scanningEnabled = false;
    response = await fetch(url, { method: 'POST', headers: { 'x-test-user': '1' }, body: upload(33) });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).code, 'FEATURE_DISABLED');
    assert.equal(calls.length, 0);
    scanningEnabled = true;
    response = await fetch(url, { method: 'POST', headers: { 'x-test-user': '1' }, body: upload() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), draft);
    assert.equal(calls.length, 1);
    response = await fetch(url, { method: 'POST', headers: { 'x-test-user': '1' }, body: upload(33) });
    assert.equal(response.status, 413);
    response = await fetch(url, { method: 'POST', headers: { 'x-test-user': '1' }, body: upload(4, true) });
    assert.equal(response.status, 400);
    response = await fetch(url, { method: 'POST', headers: { 'x-test-user': '1' } });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 1);
    holdScan = true;
    const controller = new AbortController();
    const disconnected = assert.rejects(fetch(url, {
      method: 'POST', headers: { 'x-test-user': '2' }, body: upload(), signal: controller.signal
    }), { name: 'AbortError' });
    await started;
    controller.abort();
    await Promise.all([disconnected, aborted]);
    holdScan = false;
    response = await fetch(url, { method: 'POST', headers: { 'x-test-user': '2' }, body: upload() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), draft);
    assert.equal(calls.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
