/** @file Regression coverage for security middleware: browser mutation origin guard rejects cross-origin and same-site sibling requests. */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createAuthRateLimiters, createBrowserMutationOriginGuard } = require('../src/middleware/security');

test('browser mutation origin guard rejects cross-origin and same-site sibling requests', async (t) => {
  const app = express();
  app.use(createBrowserMutationOriginGuard({
    trustedOrigins: new Set(['https://trusted-client.example']),
    useSecureRequestOrigin: true
  }));
  app.post('/mutation', (_req, res) => res.json({ ok: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/mutation`;
  const secureApiOrigin = `https://127.0.0.1:${address.port}`;

  assert.equal((await fetch(url, {
    method: 'POST', headers: { origin: 'https://app.example' }
  })).status, 403);
  assert.equal((await fetch(url, {
    method: 'POST', headers: { origin: secureApiOrigin }
  })).status, 200);
  assert.equal((await fetch(url, {
    method: 'POST', headers: { origin: 'https://trusted-client.example' }
  })).status, 200);
  assert.equal((await fetch(url, {
    method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }
  })).status, 403);
  assert.equal((await fetch(url, { method: 'POST' })).status, 200);
});

test('browser mutation origin guard permits arbitrary loopback ports only when development policy is enabled', async (t) => {
  const createApp = (allowDevelopmentLoopbackOrigins) => {
    const app = express();
    app.use(createBrowserMutationOriginGuard({
      trustedOrigins: new Set(['http://localhost:8081']),
      useSecureRequestOrigin: false,
      allowDevelopmentLoopbackOrigins
    }));
    app.post('/mutation', (_req, res) => res.json({ ok: true }));
    return app;
  };

  const developmentServer = createApp(true).listen(0, '127.0.0.1');
  const deployedServer = createApp(false).listen(0, '127.0.0.1');
  await Promise.all([
    new Promise((resolve) => developmentServer.once('listening', resolve)),
    new Promise((resolve) => deployedServer.once('listening', resolve))
  ]);
  t.after(() => Promise.all([
    new Promise((resolve) => developmentServer.close(resolve)),
    new Promise((resolve) => deployedServer.close(resolve))
  ]));

  const developmentAddress = developmentServer.address();
  const deployedAddress = deployedServer.address();
  assert.ok(developmentAddress && typeof developmentAddress === 'object');
  assert.ok(deployedAddress && typeof deployedAddress === 'object');

  const request = (port, origin) => fetch(`http://127.0.0.1:${port}/mutation`, {
    method: 'POST',
    headers: { origin }
  });

  assert.equal((await request(developmentAddress.port, 'http://localhost:8081')).status, 200);
  assert.equal((await request(developmentAddress.port, 'http://127.0.0.1:19006')).status, 200);
  assert.equal((await request(developmentAddress.port, 'http://untrusted.example:8081')).status, 403);
  assert.equal((await request(deployedAddress.port, 'http://localhost:19006')).status, 403);
  assert.equal((await request(deployedAddress.port, 'http://localhost:8081')).status, 200);
});

test('auth rate limiting is narrow and returns a JSON 429 response', async (t) => {
  const app = express();
  const limiters = createAuthRateLimiters();
  app.post('/register', limiters.registration, (_req, res) => res.json({ ok: true }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
    const response = await fetch(`${origin}/register`, { method: 'POST' });
    assert.equal(response.status, 200);
  }

  const limited = await fetch(`${origin}/register`, { method: 'POST' });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { message: 'Too many registration attempts. Try again later.' });

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
});

test('Wear pairing issuance and exchange have dedicated abuse limits', async (t) => {
  const app = express();
  const limiters = createAuthRateLimiters();
  app.post(
    '/pairing-credential',
    (req, res, next) => {
      const sessionId = Number(req.get('x-mobile-session-id'));
      if (Number.isSafeInteger(sessionId) && sessionId > 0) res.locals.mobileAuthSessionId = sessionId;
      next();
    },
    limiters.pairingIssue,
    (_req, res) => res.json({ ok: true })
  );
  app.post('/pair', limiters.pairingExchange, (_req, res) => res.json({ ok: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  for (let requestNumber = 0; requestNumber < 25; requestNumber += 1) {
    assert.equal((await fetch(`${origin}/pairing-credential`, { method: 'POST' })).status, 200);
  }
  for (let requestNumber = 0; requestNumber < 20; requestNumber += 1) {
    assert.equal((await fetch(`${origin}/pairing-credential`, {
      method: 'POST', headers: { 'x-mobile-session-id': '73' }
    })).status, 200);
  }
  const issueLimited = await fetch(`${origin}/pairing-credential`, {
    method: 'POST', headers: { 'x-mobile-session-id': '73' }
  });
  assert.equal(issueLimited.status, 429);
  assert.deepEqual(await issueLimited.json(), { message: 'Too many Wear pairing requests. Try again later.' });
  assert.equal((await fetch(`${origin}/pairing-credential`, {
    method: 'POST', headers: { 'x-mobile-session-id': '74' }
  })).status, 200);

  for (let requestNumber = 0; requestNumber < 30; requestNumber += 1) {
    assert.equal((await fetch(`${origin}/pair`, { method: 'POST' })).status, 200);
  }
  const exchangeLimited = await fetch(`${origin}/pair`, { method: 'POST' });
  assert.equal(exchangeLimited.status, 429);
  assert.deepEqual(await exchangeLimited.json(), { message: 'Too many Wear pairing attempts. Try again later.' });
});

test('Wear pairing issuance has a coarse pre-authentication IP limit', async (t) => {
  const app = express();
  const limiters = createAuthRateLimiters();
  app.post('/pairing-credential', limiters.pairingIssueIp, (_req, res) => res.json({ ok: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/pairing-credential`;

  for (let requestNumber = 0; requestNumber < 60; requestNumber += 1) {
    assert.equal((await fetch(url, { method: 'POST' })).status, 200);
  }
  const limited = await fetch(url, { method: 'POST' });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), {
    message: 'Too many Wear pairing requests from this network. Try again later.'
  });
});
