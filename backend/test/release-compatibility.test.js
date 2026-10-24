/** @file Regression coverage for release compatibility: servers support clients from the same or an older minor version. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLIENT_SERVER_COMPATIBILITY_STATUSES,
  compareClientServerCompatibility,
  formatMajorVersion,
  formatMinorVersion,
  getClientServerCompatibilityMismatch
} = require('../../shared/releaseCompatibility');

test('servers support clients from the same or an older minor version', () => {
  for (const [clientVersion, serverVersion] of [
    ['0.34.0', '0.99.99'],
    ['1.2.3-internal.4', '1.999.0+build.8'],
    ['10.20.30', '10.20.0'],
    ['12.34.56+client', '12.34.0-server']
  ]) {
    assert.equal(
      compareClientServerCompatibility(clientVersion, serverVersion),
      CLIENT_SERVER_COMPATIBILITY_STATUSES.COMPATIBLE
    );
    assert.equal(getClientServerCompatibilityMismatch(clientVersion, serverVersion), null);
  }
});

test('major mismatches block directionally and a newer client minor requires a newer server', () => {
  assert.equal(compareClientServerCompatibility('1.99.9', '2.0.0'), 'client_behind');
  assert.equal(compareClientServerCompatibility('2.0.0', '1.999.99'), 'server_behind');
  assert.equal(compareClientServerCompatibility('1.35.0', '1.34.99'), 'server_behind');
  assert.deepEqual(getClientServerCompatibilityMismatch('1.35.0', '1.34.9'), {
    clientVersion: '1.35.0',
    serverVersion: '1.34.9',
    status: 'server_behind'
  });
});

test('malformed semantic versions fail closed', () => {
  for (const version of ['1.2', '1.2.3.4', '01.2.3', '1.2.3-..', '1.2.3+..', ' future ']) {
    assert.equal(compareClientServerCompatibility(version, '1.2.3'), 'invalid');
    assert.equal(compareClientServerCompatibility('1.2.3', version), 'invalid');
    assert.equal(formatMajorVersion(version), null);
    assert.equal(formatMinorVersion(version), null);
    assert.deepEqual(getClientServerCompatibilityMismatch('1.2.3', version), {
      clientVersion: '1.2.3',
      serverVersion: 'invalid',
      status: 'invalid'
    });
  }
  assert.equal(compareClientServerCompatibility(undefined, '1.2.3'), 'invalid');
  assert.deepEqual(getClientServerCompatibilityMismatch('1.2.3', undefined), {
    clientVersion: '1.2.3',
    serverVersion: 'unknown',
    status: 'invalid'
  });
  assert.equal(formatMajorVersion('12.34.56-internal'), '12.x');
  assert.equal(formatMinorVersion('12.34.56-internal'), '12.34.x');
});

test('compatibility comparison does not lose precision for large canonical identifiers', () => {
  const largeMajor = `${'9'.repeat(400)}.0.0`;
  const largeMinor = '9'.repeat(400);
  assert.equal(compareClientServerCompatibility(largeMajor, '10.0.0'), 'server_behind');
  assert.equal(compareClientServerCompatibility(`1.${largeMinor}.0`, '1.10.0'), 'server_behind');
  assert.equal(compareClientServerCompatibility('1.10.0', `1.${largeMinor}.0`), 'compatible');
});
