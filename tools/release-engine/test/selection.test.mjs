/** @file Exercise no-op selection, platform isolation, explicit cohorts, and transitive repository-specific dependencies. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectComponents } from '../index.mjs';

const component = (id, changed = false, kind = 'native') => ({ id, kind, identity: changed ? 'new' : 'same', baselineIdentity: 'same' });

test('unchanged semantic identities remain a true no-op despite descriptive reasons', () => {
  const result = selectComponents({ components: [{ ...component('server', false, 'server'), reasons: ['metadata was inspected'] }] });
  assert.equal(result.noop, true);
  assert.deepEqual(result.selected, []);
});

test('platform-specific native changes do not select another platform or unchanged OTA', () => {
  assert.deepEqual(selectComponents({ components: [component('ios', true), component('android'), component('ota.android', false, 'ota')] }).selected, ['ios']);
});

test('cohorts and metadata dependencies expand transitively and deterministically', () => {
  const components = [component('wear', true), component('phone'), component('server'), component('ota')];
  const groups = [['phone', 'wear']];
  const dependencies = [{ component: 'phone', requires: ['server'] }];
  const result = selectComponents({ components, groups, dependencies });
  assert.deepEqual(result.selected, ['phone', 'server', 'wear']);
  assert.deepEqual(result, selectComponents({ components: [...components].reverse(), groups: [['wear', 'phone']], dependencies }));
  assert.ok(result.components.find((item) => item.id === 'server').reasons.includes('required-by:phone'));
});

test('first releases and explicit force select while disabled prerequisites fail closed', () => {
  assert.equal(selectComponents({ components: [{ ...component('first'), baselineIdentity: null }] }).noop, false);
  assert.equal(selectComponents({ components: [{ ...component('forced'), force: true }] }).noop, false);
  assert.throws(() => selectComponents({ components: [component('phone', true), { ...component('wear'), enabled: false }], groups: [['phone', 'wear']] }), /disabled/);
  assert.throws(() => selectComponents({ components: [component('phone')], dependencies: [{ component: 'phone', requires: ['missing'] }] }), /Unknown/);
  assert.throws(() => selectComponents({ components: [component('phone'), component('phone')] }), /Duplicate/);
});
