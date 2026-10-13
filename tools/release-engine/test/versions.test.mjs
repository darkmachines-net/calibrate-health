/** @file Verify semantic version boundaries and globally monotonic disjoint phone/Wear code reservation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { bumpVersion, nextReservedVersion, parseVersion } from '../index.mjs';

test('stable semantic bumps reset only subordinate fields', () => {
  assert.equal(bumpVersion('1.9.8', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.9.8', 'minor'), '1.10.0');
  assert.equal(bumpVersion('1.9.8', 'patch'), '1.9.9');
  for (const invalid of ['01.2.3', '1.2', '1.2.3-beta', 'v1.2.3', '9007199254740992.0.0']) assert.throws(() => parseVersion(invalid));
  assert.throws(() => bumpVersion('9007199254740991.0.0', 'major'));
});

test('reservations account for failed prior releases and other artifact roles', () => {
  const used = [301, 302, 399, 400];
  const phone = nextReservedVersion({ used, modulus: 2, residue: 1 });
  const wear = nextReservedVersion({ used: [...used, phone], modulus: 2, residue: 0 });
  assert.equal(phone, 401);
  assert.equal(wear, 402);
  assert.equal(nextReservedVersion({ after: 400, modulus: 2, residue: 0 }), 402);
  assert.equal(nextReservedVersion(), 1);
  assert.throws(() => nextReservedVersion({ used: [Number.MAX_SAFE_INTEGER] }), /overflow/);
  assert.throws(() => nextReservedVersion({ modulus: 2, residue: 2 }), /policy/);
  assert.throws(() => nextReservedVersion({ used: [-1] }), /positive/);
});
