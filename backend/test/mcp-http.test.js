/** @file Regression coverage for mcp http: MCP discovery advertises the exact resource and public PKCE authorization server. */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';

const { createCalibrateMcpHttpApp } = require('../src/mcp/server');
const {
  MCP_OAUTH_AUTHORIZATION_RATE_LIMIT_MAX,
  MCP_OAUTH_REGISTRATION_RATE_LIMIT_MAX
} = require('../src/mcp/oauth');

async function withServer(run, overrides = {}) {
  const app = createCalibrateMcpHttpApp({
    publicUrl: new URL('https://calibratehealth.app/mcp'),
    allowedHosts: ['127.0.0.1', 'calibratehealth.app'],
    trustedProxyHops: 0,
    oauthApprovalRateLimiter: (_request, _response, next) => next(),
    ...overrides
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('MCP discovery advertises the exact resource and public PKCE authorization server', async () => {
  await withServer(async (baseUrl) => {
    const resourceResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(resourceResponse.status, 200);
    const resource = await resourceResponse.json();
    assert.equal(resource.resource, 'https://calibratehealth.app/mcp');
    assert.deepEqual(resource.scopes_supported, [
      'calibrate:food:read',
      'calibrate:weight:read'
    ]);

    const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.issuer, 'https://calibratehealth.app/');
    assert.equal(metadata.authorization_endpoint, 'https://calibratehealth.app/authorize');
    assert.equal(metadata.token_endpoint, 'https://calibratehealth.app/token');
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  });
});

test('unauthenticated MCP calls return a resource-metadata challenge and stateless method guidance', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(
      response.headers.get('www-authenticate'),
      /resource_metadata="https:\/\/calibratehealth\.app\/\.well-known\/oauth-protected-resource\/mcp"/
    );
    const body = await response.json();
    assert.equal(body.error.code, -32001);

    const getResponse = await fetch(`${baseUrl}/mcp`);
    assert.equal(getResponse.status, 405);
    assert.equal(getResponse.headers.get('cache-control'), 'no-store');
    const deleteResponse = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 405);
    assert.equal(deleteResponse.headers.get('cache-control'), 'no-store');
  });
});

test('MCP storage failures return a non-cacheable 503 without an OAuth challenge loop', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer opaque-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('www-authenticate'), null);
    const body = await response.json();
    assert.equal(body.error.code, -32603);
  }, {
    oauthService: {
      verifyAccessToken: async () => { throw new Error('database unavailable'); }
    }
  });
});

test('OAuth approval uses the supplied limiter and configured proxy hop without caching', async () => {
  let observedIp;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/oauth/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.9'
      },
      body: 'request_id=opaque&decision=approve'
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(observedIp, '203.0.113.9');
  }, {
    trustedProxyHops: 1,
    oauthApprovalRateLimiter: (request, response) => {
      observedIp = request.ip;
      response.status(429).json({ message: 'limited' });
    }
  });
});

test('dynamic registration rejects oversized metadata before persistence', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: `Oversized ${'x'.repeat(17 * 1024)}`,
        redirect_uris: ['https://chatgpt.com/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'invalid_client_metadata');
  });
});

test('dynamic registration rejects insecure non-loopback callbacks before persistence', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Untrusted client',
        redirect_uris: ['http://attacker.example/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'invalid_client_metadata');
  });
});

test('dynamic registration is rate-limited before another client is persisted', async () => {
  let persistedClients = 0;
  await withServer(async (baseUrl) => {
    const body = JSON.stringify({
      client_name: 'Rate-limit test client',
      redirect_uris: ['https://chatgpt.com/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    });
    for (let attempt = 0; attempt < MCP_OAUTH_REGISTRATION_RATE_LIMIT_MAX; attempt += 1) {
      const response = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      });
      assert.equal(response.status, 201);
    }

    const limited = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    assert.equal((await limited.json()).error, 'too_many_requests');
    assert.equal(persistedClients, MCP_OAUTH_REGISTRATION_RATE_LIMIT_MAX);
  }, {
    oauthService: {
      saveClient: async (client) => {
        persistedClients += 1;
        return client;
      }
    }
  });
});

test('authorization is rate-limited before another approval request is persisted', async () => {
  let persistedRequests = 0;
  const client = {
    client_id: 'rate-limit-client',
    client_name: 'Rate-limit test client',
    redirect_uris: ['http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  };
  await withServer(async (baseUrl) => {
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      scope: 'calibrate:food:read calibrate:weight:read',
      state: 'rate-limit-state',
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256',
      resource: 'https://calibratehealth.app/mcp'
    }).toString();
    for (let attempt = 0; attempt < MCP_OAUTH_AUTHORIZATION_RATE_LIMIT_MAX; attempt += 1) {
      const response = await fetch(authorizeUrl);
      assert.equal(response.status, 200);
    }

    const limited = await fetch(authorizeUrl);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    assert.equal((await limited.json()).error, 'too_many_requests');
    assert.equal(persistedRequests, MCP_OAUTH_AUTHORIZATION_RATE_LIMIT_MAX);
  }, {
    oauthService: {
      getClient: async (clientId) => clientId === client.client_id ? client : undefined,
      beginAuthorization: async (input) => {
        persistedRequests += 1;
        return {
          id: `request-${persistedRequests}`,
          clientId: input.clientId,
          clientName: client.client_name,
          redirectUri: input.redirectUri,
          state: input.state,
          scopes: input.scopes,
          resource: input.resource,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        };
      }
    }
  });
});
