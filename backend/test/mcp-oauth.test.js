/** @file Regression coverage for mcp oauth: MCP OAuth stores a hashed, ten-minute approval credential for an exact resource. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadMcpOAuthService(prismaStub) {
  const dbPath = require.resolve('../src/config/database');
  const accountAccessPath = require.resolve('../src/services/accountAccess');
  const servicePath = require.resolve('../src/services/mcpOAuth');
  const previousDb = require.cache[dbPath];
  const previousAccountAccess = require.cache[accountAccessPath];
  delete require.cache[servicePath];
  delete require.cache[accountAccessPath];
  stubModule(dbPath, prismaStub);
  const loaded = require('../src/services/mcpOAuth');
  if (previousDb) require.cache[dbPath] = previousDb;
  else delete require.cache[dbPath];
  if (previousAccountAccess) require.cache[accountAccessPath] = previousAccountAccess;
  else delete require.cache[accountAccessPath];
  return loaded;
}

const FIXED_NOW = new Date('2026-08-19T12:00:00.000Z');

test('MCP OAuth stores a hashed, ten-minute approval credential for an exact resource', async () => {
  let created;
  const client = {
    client_id: 'codex-client',
    client_name: 'Codex',
    redirect_uris: ['http://127.0.0.1:48741/callback'],
    token_endpoint_auth_method: 'none'
  };
  const prismaStub = {
    $transaction: async (operations) => Promise.all(operations),
    mcpOAuthClient: { findUnique: async () => ({ metadata_json: client }) },
    mcpOAuthAuthorizationRequest: {
      deleteMany: async () => ({ count: 0 }),
      create: async (args) => { created = args; return args.data; }
    },
    mcpOAuthAuthorizationCode: { deleteMany: async () => ({ count: 0 }) },
    mcpOAuthAccessToken: { deleteMany: async () => ({ count: 0 }) },
    mcpOAuthRefreshToken: { deleteMany: async () => ({ count: 0 }) }
  };
  const { McpOAuthService } = loadMcpOAuthService(prismaStub);
  const service = new McpOAuthService(prismaStub, () => FIXED_NOW);
  const request = await service.beginAuthorization({
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    state: 'opaque-state',
    scopes: ['calibrate:food:read'],
    codeChallenge: 'A'.repeat(43),
    resource: 'https://calibratehealth.app/mcp'
  });

  assert.match(request.id, /^calibrate_mcp_request_/);
  assert.match(created.data.request_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(created.data.request_hash, request.id);
  assert.deepEqual(created.data.scopes, ['calibrate:food:read']);
  assert.equal(created.data.resource, 'https://calibratehealth.app/mcp');
  assert.equal(created.data.expires_at.toISOString(), '2026-08-19T12:10:00.000Z');
});

test('MCP OAuth dynamic client persistence strips client secrets', async () => {
  let upserted;
  const prismaStub = {
    mcpOAuthClient: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async (args) => { upserted = args; return args.create; }
    }
  };
  const { McpOAuthService } = loadMcpOAuthService(prismaStub);
  const service = new McpOAuthService(prismaStub, () => FIXED_NOW);
  const saved = await service.saveClient({
    client_id: 'public-client',
    redirect_uris: ['https://chatgpt.com/callback'],
    token_endpoint_auth_method: 'client_secret_post',
    client_secret: 'must-not-persist',
    client_secret_expires_at: 0
  });

  assert.equal(saved.token_endpoint_auth_method, 'none');
  assert.equal(saved.client_secret, undefined);
  assert.equal(upserted.create.metadata_json.client_secret, undefined);
});

test('MCP OAuth uses different purpose-bound hashes for the same token text', async () => {
  const hashes = [];
  const prismaStub = {
    mcpOAuthAccessToken: { findUnique: async ({ where }) => { hashes.push(where.token_hash); return null; } },
    mcpOAuthRefreshToken: { findUnique: async ({ where }) => { hashes.push(where.token_hash); return null; } }
  };
  const { McpOAuthService } = loadMcpOAuthService(prismaStub);
  await new McpOAuthService(prismaStub, () => FIXED_NOW).revokeToken('client', 'same-opaque-value');
  assert.equal(hashes.length, 2);
  assert.match(hashes[0], /^[a-f0-9]{64}$/);
  assert.match(hashes[1], /^[a-f0-9]{64}$/);
  assert.notEqual(hashes[0], hashes[1]);
});

test('MCP OAuth revokes the entire grant when refresh-token replay wins a race', async () => {
  let revokedAt;
  const stored = {
    token_hash: 'stored-hash',
    grant_id: 'c13e23d9-b130-42bd-bb70-901fd65fbfe9',
    scopes: ['calibrate:weight:read'],
    expires_at: new Date('2026-09-01T12:00:00.000Z'),
    used_at: null,
    grant: {
      id: 'c13e23d9-b130-42bd-bb70-901fd65fbfe9',
      client_id: 'codex-client',
      resource: 'https://calibratehealth.app/mcp',
      revoked_at: null
    }
  };
  const tx = {
    mcpOAuthAccessToken: { deleteMany: async () => ({ count: 0 }) },
    mcpOAuthRefreshToken: {
      deleteMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 })
    },
    mcpOAuthGrant: {
      updateMany: async ({ data }) => { revokedAt = data.revoked_at; return { count: 1 }; }
    }
  };
  const prismaStub = {
    mcpOAuthRefreshToken: { findUnique: async () => stored },
    $transaction: async (callback) => callback(tx)
  };
  const { McpOAuthError, McpOAuthService } = loadMcpOAuthService(prismaStub);
  const service = new McpOAuthService(prismaStub, () => FIXED_NOW);

  await assert.rejects(
    service.exchangeRefreshToken(
      'codex-client',
      'already-presented-refresh-token',
      undefined,
      'https://calibratehealth.app/mcp'
    ),
    (error) => error instanceof McpOAuthError && error.reason === 'invalid_grant'
  );
  assert.equal(revokedAt.toISOString(), FIXED_NOW.toISOString());
});

test('MCP OAuth refresh rotation prunes only expired credentials for the active grant', async () => {
  const grantId = 'c13e23d9-b130-42bd-bb70-901fd65fbfe9';
  const cleanup = {};
  const stored = {
    token_hash: 'stored-hash',
    grant_id: grantId,
    scopes: ['calibrate:food:read'],
    expires_at: new Date('2026-09-01T12:00:00.000Z'),
    used_at: null,
    grant: {
      id: grantId,
      client_id: 'codex-client',
      resource: 'https://calibratehealth.app/mcp',
      revoked_at: null
    }
  };
  const tx = {
    mcpOAuthAccessToken: {
      deleteMany: async (args) => { cleanup.access = args; return { count: 3 }; },
      create: async () => ({})
    },
    mcpOAuthRefreshToken: {
      deleteMany: async (args) => { cleanup.refresh = args; return { count: 2 }; },
      updateMany: async () => ({ count: 1 }),
      create: async () => ({})
    },
    mcpOAuthGrant: { updateMany: async () => ({ count: 1 }) }
  };
  const prismaStub = {
    mcpOAuthRefreshToken: { findUnique: async () => stored },
    $transaction: async (callback) => callback(tx)
  };
  const { McpOAuthService } = loadMcpOAuthService(prismaStub);
  const tokens = await new McpOAuthService(prismaStub, () => FIXED_NOW).exchangeRefreshToken(
    'codex-client',
    'active-refresh-token',
    undefined,
    'https://calibratehealth.app/mcp'
  );
  assert.match(tokens.accessToken, /^calibrate_mcp_access_/);
  assert.deepEqual(cleanup.access.where, { grant_id: grantId, expires_at: { lte: FIXED_NOW } });
  assert.deepEqual(cleanup.refresh.where, { grant_id: grantId, expires_at: { lte: FIXED_NOW } });
  assert.equal('used_at' in cleanup.refresh.where, false);
});

test('MCP OAuth approval cannot create a code after the security version changes with the same password hash', async () => {
  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash('old-password', 4);
  let createdCode = false;
  let deletedRequest;
  const request = {
    request_hash: 'request-hash',
    client_id: 'codex-client',
    redirect_uri: 'http://127.0.0.1:48741/callback',
    state: 'state',
    scopes: ['calibrate:food:read'],
    code_challenge: 'A'.repeat(43),
    resource: 'https://calibratehealth.app/mcp',
    expires_at: new Date('2026-08-19T12:10:00.000Z')
  };
  const tx = {
    user: { updateMany: async ({ where, data }) => {
      assert.deepEqual(where, { id: 7, credential_security_version: 3 });
      assert.deepEqual(data, { credential_security_version: 3 });
      const currentVersion = 4;
      return { count: where.credential_security_version === currentVersion ? 1 : 0 };
    } },
    mcpOAuthAuthorizationRequest: {
      deleteMany: async (args) => { deletedRequest = args; return { count: 1 }; }
    },
    mcpOAuthAuthorizationCode: {
      create: async () => { createdCode = true; }
    }
  };
  const prismaStub = {
    mcpOAuthAuthorizationRequest: { findUnique: async () => request },
    user: {
      findFirst: async () => ({ id: 7, password_hash: passwordHash, credential_security_version: 3 })
    },
    $transaction: async (callback) => callback(tx)
  };
  const { McpOAuthError, McpOAuthService } = loadMcpOAuthService(prismaStub);
  const service = new McpOAuthService(prismaStub, () => FIXED_NOW);
  await assert.rejects(
    service.approveAuthorization({
      requestId: 'opaque-request',
      email: 'test@example.com',
      password: 'old-password'
    }),
    (error) => error instanceof McpOAuthError && error.reason === 'expired'
  );
  assert.equal(createdCode, false);
  assert.match(deletedRequest.where.request_hash, /^[a-f0-9]{64}$/);
});
