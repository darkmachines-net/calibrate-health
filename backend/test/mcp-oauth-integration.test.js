/** @file Regression coverage for mcp oauth integration: remote MCP completes DCR, PKCE approval, tool use, refresh rotation, replay rejection, and revocation. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';

const { createCalibrateMcpHttpApp } = require('../src/mcp/server');
const { McpOAuthError } = require('../src/services/mcpOAuth');

function createInMemoryOAuthService(resource) {
  const clients = new Map();
  const requests = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  let sequence = 0;
  let revoked = false;

  const next = (kind) => `integration-${kind}-${++sequence}`;
  const issueTokens = (clientId, scopes) => {
    const accessToken = next('access');
    const refreshToken = next('refresh');
    accessTokens.set(accessToken, { clientId, scopes });
    refreshTokens.set(refreshToken, { clientId, scopes, used: false });
    return { accessToken, refreshToken, expiresIn: 3600, scopes };
  };

  return {
    async getClient(clientId) {
      return clients.get(clientId);
    },
    async saveClient(client) {
      clients.set(client.client_id, client);
      return client;
    },
    async beginAuthorization(input) {
      const client = clients.get(input.clientId);
      if (!client) throw new McpOAuthError('invalid_grant');
      const id = next('request');
      const request = {
        id,
        ...input,
        clientName: client.client_name,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      };
      requests.set(id, request);
      return request;
    },
    async authorizationRequest(id) {
      return requests.get(id) ?? null;
    },
    async cancelAuthorization(id) {
      const request = requests.get(id);
      if (!request) throw new McpOAuthError('expired');
      requests.delete(id);
      return request;
    },
    async approveAuthorization({ requestId, email, password }) {
      const request = requests.get(requestId);
      if (!request) throw new McpOAuthError('expired');
      if (email !== 'test@calibratehealth.app' || password !== 'secret') {
        throw new McpOAuthError('invalid_credentials');
      }
      requests.delete(requestId);
      const code = next('code');
      codes.set(code, request);
      return { code, redirectUri: request.redirectUri, state: request.state };
    },
    async challengeForAuthorizationCode(clientId, code) {
      const authorization = codes.get(code);
      if (!authorization || authorization.clientId !== clientId) {
        throw new McpOAuthError('invalid_grant');
      }
      return authorization.codeChallenge;
    },
    async exchangeAuthorizationCode(clientId, code, redirectUri, requestedResource) {
      const authorization = codes.get(code);
      if (!authorization || authorization.clientId !== clientId ||
        authorization.redirectUri !== redirectUri || requestedResource !== resource) {
        throw new McpOAuthError('invalid_grant');
      }
      codes.delete(code);
      return issueTokens(clientId, authorization.scopes);
    },
    async exchangeRefreshToken(clientId, refreshToken, requestedScopes, requestedResource) {
      const stored = refreshTokens.get(refreshToken);
      if (!stored || stored.used || stored.clientId !== clientId || requestedResource !== resource || revoked) {
        throw new McpOAuthError('invalid_grant');
      }
      const scopes = requestedScopes?.length ? requestedScopes : stored.scopes;
      if (scopes.some((scope) => !stored.scopes.includes(scope))) {
        throw new McpOAuthError('invalid_scope');
      }
      stored.used = true;
      return issueTokens(clientId, scopes);
    },
    async verifyAccessToken(token) {
      const stored = accessTokens.get(token);
      if (!stored || revoked) throw new McpOAuthError('invalid_grant');
      return {
        clientId: stored.clientId,
        userId: 7,
        scopes: stored.scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource
      };
    },
    async revokeToken(clientId, token) {
      const access = accessTokens.get(token);
      const refresh = refreshTokens.get(token);
      if (access?.clientId === clientId || refresh?.clientId === clientId) revoked = true;
    }
  };
}

test('remote MCP completes DCR, PKCE approval, tool use, refresh rotation, replay rejection, and revocation', async () => {
  const http = createServer();
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const resource = `${origin}/mcp`;
  const oauthService = createInMemoryOAuthService(resource);
  const app = createCalibrateMcpHttpApp({
    publicUrl: new URL(resource),
    allowedHosts: ['127.0.0.1'],
    trustedProxyHops: 0,
    oauthApprovalRateLimiter: (_request, _response, next) => next(),
    oauthService,
    progressReaders: {
      getRecentFoodLogs: async (_userId, { days }) => ({
        as_of_date: '2026-08-19',
        requested_days: days,
        days: [],
        representative_summary: { complete_day_count: 0 }
      }),
      getWeightTrend: async () => ({ as_of_date: '2026-08-19', points: [] })
    }
  });
  http.on('request', app);

  let client;
  try {
    const registration = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'Calibrate integration test'
      })
    });
    assert.equal(registration.status, 201);
    const registeredClient = await registration.json();
    assert.ok(registeredClient.client_id);
    assert.equal(registeredClient.client_secret, undefined);

    const verifier = 'calibrate-integration-verifier-long-enough-for-pkce-2026';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeUrl = new URL(`${origin}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: registeredClient.client_id,
      redirect_uri: 'http://127.0.0.1/callback',
      scope: 'calibrate:food:read calibrate:weight:read',
      state: 'integration-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource
    }).toString();
    const authorization = await fetch(authorizeUrl);
    assert.equal(authorization.status, 200);
    const authorizationHtml = await authorization.text();
    assert.match(authorizationHtml, /Connect Calibrate integration test/);
    assert.match(authorizationHtml, /profile-estimated TDEE/);
    const requestId = authorizationHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
    assert.ok(requestId);

    const approval = await fetch(`${origin}/oauth/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: new URLSearchParams({
        request_id: requestId,
        email: 'test@calibratehealth.app',
        password: 'secret',
        decision: 'approve'
      })
    });
    assert.equal(approval.status, 302);
    const callback = new URL(approval.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'integration-state');
    assert.equal(callback.searchParams.get('iss'), `${origin}/`);
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const exchange = await fetch(`${origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1/callback',
        client_id: registeredClient.client_id,
        resource
      })
    });
    assert.equal(exchange.status, 200);
    const firstTokens = await exchange.json();
    assert.equal(firstTokens.expires_in, 3600);
    assert.equal(firstTokens.scope, 'calibrate:food:read calibrate:weight:read');

    client = new Client({ name: 'calibrate-integration-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${firstTokens.access_token}` } }
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'compare_progress_periods',
      'get_progress_summary',
      'get_recent_food_logs',
      'get_weight_trend',
      'open_progress_explorer'
    ]);
    const food = await client.callTool({ name: 'get_recent_food_logs', arguments: { days: 7 } });
    assert.equal(food.structuredContent.requested_days, 7);
    await client.close();
    client = undefined;

    const refresh = await fetch(`${origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: firstTokens.refresh_token,
        client_id: registeredClient.client_id,
        resource
      })
    });
    assert.equal(refresh.status, 200);
    const refreshedTokens = await refresh.json();
    assert.notEqual(refreshedTokens.refresh_token, firstTokens.refresh_token);

    const replay = await fetch(`${origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: firstTokens.refresh_token,
        client_id: registeredClient.client_id,
        resource
      })
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_grant');

    const revoke = await fetch(`${origin}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshedTokens.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: registeredClient.client_id
      })
    });
    assert.equal(revoke.status, 200);
    const revokedCall = await fetch(resource, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${refreshedTokens.access_token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(revokedCall.status, 401);
  } finally {
    if (client) await client.close();
    await new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  }
});
