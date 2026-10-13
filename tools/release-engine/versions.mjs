/** @file Stable semantic version and disjoint positive native build-number allocation primitives. */
import { invariant } from './core.mjs';

/** Parse a stable major.minor.patch version, rejecting prerelease aliases and unsafe numeric values. */
export function parseVersion(value) {
  invariant(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), 'Version must be stable major.minor.patch.');
  const [major, minor, patch] = value.split('.').map(Number);
  invariant([major, minor, patch].every(Number.isSafeInteger), 'Version fields exceed safe integer limits.');
  return Object.freeze({ major, minor, patch });
}

/** Advance one semantic version field and reset lower fields; overflow fails before reserving a release. */
export function bumpVersion(value, bump) {
  const version = parseVersion(value);
  invariant(['major', 'minor', 'patch'].includes(bump), 'Version bump must be major, minor, or patch.');
  const major = version.major + (bump === 'major' ? 1 : 0);
  const minor = bump === 'major' ? 0 : version.minor + (bump === 'minor' ? 1 : 0);
  const patch = bump !== 'patch' ? 0 : version.patch + 1;
  const result = `${major}.${minor}.${patch}`;
  parseVersion(result);
  return result;
}

/** Allocate above every observed/reserved code, optionally on a disjoint residue class such as odd phone/even Wear codes. */
export function nextReservedVersion({ used = [], after = 0, modulus = 1, residue = 0 } = {}) {
  invariant(Array.isArray(used) && used.every((code) => Number.isSafeInteger(code) && code > 0), 'Reserved versions must be positive safe integers.');
  invariant(Number.isSafeInteger(after) && after >= 0, 'Version lower bound must be a nonnegative safe integer.');
  invariant(Number.isSafeInteger(modulus) && modulus > 0 && Number.isSafeInteger(residue) && residue >= 0 && residue < modulus, 'Invalid version residue policy.');
  const highest = used.reduce((maximum, code) => Math.max(maximum, code), after);
  let next = highest + 1;
  invariant(Number.isSafeInteger(next), 'Native version allocation overflow.');
  const difference = residue - next % modulus;
  next += difference < 0 ? difference + modulus : difference;
  invariant(Number.isSafeInteger(next) && next > highest, 'Native version allocation overflow.');
  return next;
}
