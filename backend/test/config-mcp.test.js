/** @file Regression coverage for config mcp: official hosted deployments expose the canonical HTTPS MCP resource. */

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveMcpConfiguration } = require('../src/config/mcp');

test('official hosted deployments expose the canonical HTTPS MCP resource', () => {
  const config = resolveMcpConfiguration({
    NODE_ENV: 'production',
    CALIBRATE_HOSTED_SERVICE: 'true'
  });
  assert.equal(config.enabled, true);
  assert.equal(config.publicUrl.href, 'https://calibratehealth.app/mcp');
  assert.ok(config.allowedHosts.includes('calibratehealth.app'));
});

test('advanced self-hosts opt in and inherit PUBLIC_APP_ORIGIN', () => {
  const config = resolveMcpConfiguration({
    NODE_ENV: 'production',
    MCP_ENABLED: 'true',
    PUBLIC_APP_ORIGIN: 'https://health.example.com/some/path'
  });
  assert.equal(config.publicUrl.href, 'https://health.example.com/mcp');
  assert.deepEqual(config.allowedHosts.slice(-1), ['health.example.com']);
});

test('MCP is disabled by default for non-hosted installations', () => {
  const config = resolveMcpConfiguration({ PORT: '4321' });
  assert.equal(config.enabled, false);
  assert.equal(config.publicUrl.href, 'http://127.0.0.1:4321/mcp');
});

test('deployed MCP rejects an insecure non-loopback resource URL', () => {
  assert.throws(() => resolveMcpConfiguration({
    NODE_ENV: 'production',
    MCP_ENABLED: 'true',
    MCP_PUBLIC_URL: 'http://health.example.com/mcp'
  }), /must use HTTPS/);
});

test('explicit URLs cannot retain credentials, query strings, or fragments', () => {
  const config = resolveMcpConfiguration({
    MCP_ENABLED: 'true',
    MCP_PUBLIC_URL: 'https://user:secret@bad.example/mcp?token=secret',
    PUBLIC_APP_ORIGIN: 'https://safe.example'
  });
  assert.equal(config.publicUrl.href, 'https://safe.example/mcp');
});
