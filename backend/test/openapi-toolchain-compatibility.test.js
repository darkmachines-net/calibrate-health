/** @file Regression coverage for openapi toolchain compatibility: Redocly minimatch supports brace-bearing OpenAPI paths. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');

const redoclyPackagePath = require.resolve('@redocly/openapi-core/package.json');
const requireFromRedocly = createRequire(redoclyPackagePath);

test('Redocly minimatch supports brace-bearing OpenAPI paths', () => {
  const minimatch = requireFromRedocly('minimatch');

  assert.equal(
    minimatch('backend/openapi/v1.yaml', 'backend/openapi/{v1,v2}.yaml'),
    true
  );
});

test('OpenAPI preserves unsafe historical goal deficits while constraining new goal writes', () => {
  const yaml = fs.readFileSync(path.join(__dirname, '..', 'openapi', 'v1.yaml'), 'utf8');
  const goalEntry = yaml.slice(yaml.indexOf('    GoalEntry:'), yaml.indexOf('    GoalCreateRequest:'));
  const goalCreate = yaml.slice(yaml.indexOf('    GoalCreateRequest:'), yaml.indexOf('    MetricEntry:'));

  assert.match(goalEntry, /daily_deficit: \{ type: integer \}/);
  assert.doesNotMatch(goalEntry, /daily_deficit:.*enum:/);
  assert.match(goalCreate, /daily_deficit:.*enum: \[-1000, -750, -500, -250, 0, 250, 500, 750, 1000\]/);
});
