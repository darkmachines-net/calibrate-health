/** @file Regression coverage for mcp oauth migration: MCP OAuth migration separates clients, grants, and short-lived credentials. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '../prisma/migrations/0039_mcp_oauth/migration.sql');

test('MCP OAuth migration separates clients, grants, and short-lived credentials', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  for (const table of [
    'McpOAuthClient',
    'McpOAuthAuthorizationRequest',
    'McpOAuthAuthorizationCode',
    'McpOAuthGrant',
    'McpOAuthAccessToken',
    'McpOAuthRefreshToken'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.match(sql, /"user_id" INTEGER NOT NULL/);
  assert.match(sql, /REFERENCES "User"\("id"\) ON DELETE CASCADE/);
  assert.match(sql, /"used_at" TIMESTAMP\(3\)/);
  assert.match(sql, /"revoked_at" TIMESTAMP\(3\)/);
});

test('MCP OAuth migration persists purpose-bound hashes instead of bearer credentials', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /"request_hash" VARCHAR\(64\) NOT NULL/);
  assert.match(sql, /"code_hash" VARCHAR\(64\) NOT NULL/);
  assert.equal((sql.match(/"token_hash" VARCHAR\(64\) NOT NULL/g) ?? []).length, 2);
  assert.doesNotMatch(sql, /"access_token"\s+TEXT/);
  assert.doesNotMatch(sql, /"refresh_token"\s+TEXT/);
  assert.doesNotMatch(sql, /"authorization_code"\s+TEXT/);
  assert.doesNotMatch(sql, /"password"\s+TEXT/);
});

test('MCP OAuth migration preserves exact resource and scopes on every grant credential', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.equal((sql.match(/"resource" TEXT NOT NULL/g) ?? []).length, 3);
  assert.equal((sql.match(/"scopes" TEXT\[\] NOT NULL/g) ?? []).length, 5);
  assert.match(sql, /McpOAuthAuthorizationRequest_expires_at_idx/);
  assert.match(sql, /McpOAuthAuthorizationCode_expires_at_idx/);
  assert.match(sql, /McpOAuthAccessToken_expires_at_idx/);
  assert.match(sql, /McpOAuthRefreshToken_expires_at_idx/);
});
