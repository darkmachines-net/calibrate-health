/** @file Regression coverage for readiness: database readiness reports success without exposing probe results. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDatabaseReadiness } = require('../src/services/readiness');

test('database readiness reports success without exposing probe results', async () => {
  assert.equal(await checkDatabaseReadiness(async () => ({ secret: 'not returned' })), true);
});

test('database readiness converts connection failures into a safe false result', async () => {
  assert.equal(await checkDatabaseReadiness(async () => {
    throw new Error('postgresql://user:password@db/private');
  }), false);
});
