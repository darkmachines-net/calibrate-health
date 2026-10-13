/** @file Canonical JSON identities and immutable release plans with separate application, workflow, and toolkit provenance. */
import { createHash } from 'node:crypto';

/** Assert a public contract and throw before any side effect when it is violated. */
export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/** Validate bounded identifiers used as logical keys, never as filesystem paths. */
export function validateId(value, label = 'Identifier') {
  invariant(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value), `${label} is invalid.`);
  return value;
}

/** Serialize plain JSON deterministically, rejecting lossy values, accessors, cycles, and exotic objects. */
export function canonicalStringify(value) {
  const visiting = new Set();
  function encode(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      invariant(Number.isFinite(item), 'Canonical JSON requires finite numbers.');
      return JSON.stringify(item);
    }
    invariant(typeof item === 'object', 'Canonical JSON does not accept undefined, functions, symbols, or bigint.');
    invariant(!visiting.has(item), 'Canonical JSON does not accept cycles.');
    invariant(Object.getOwnPropertySymbols(item).length === 0, 'Canonical JSON does not accept symbol keys.');
    visiting.add(item);
    let result;
    if (Array.isArray(item)) {
      invariant(Object.keys(item).length === item.length, 'Canonical JSON requires dense arrays without extra properties.');
      invariant(Object.getOwnPropertyNames(item).length === item.length + 1, 'Canonical JSON does not accept hidden array properties.');
      const entries = [];
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        invariant(descriptor && 'value' in descriptor, 'Canonical JSON does not accept accessors.');
        entries.push(encode(descriptor.value));
      }
      result = `[${entries.join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      invariant(prototype === Object.prototype || prototype === null, 'Canonical JSON requires plain objects.');
      const entries = Object.getOwnPropertyNames(item).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        invariant(descriptor.enumerable && 'value' in descriptor, 'Canonical JSON does not accept hidden properties or accessors.');
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      });
      result = `{${entries.join(',')}}`;
    }
    visiting.delete(item);
    return result;
  }
  return encode(value);
}

/** Hash semantic input data as canonical JSON; this is distinct from a compiled artifact's byte digest. */
export function hashIdentity(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

/** Clone JSON data and recursively freeze it so callers cannot mutate a planned operation. */
export function immutable(value) {
  const cloned = JSON.parse(canonicalStringify(value));
  function freeze(item) {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  }
  return freeze(cloned);
}

/** Validate independent provenance identities; source and trusted-tool revisions need not be equal. */
export function validateSourceIdentity(source) {
  invariant(source && typeof source === 'object' && !Array.isArray(source), 'Plan source is required.');
  invariant(typeof source.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository), 'Source repository must be owner/repository.');
  invariant(source.repository.split('/').every((part) => part !== '.' && part !== '..'), 'Source repository cannot use path aliases.');
  for (const key of ['commit', 'workflowCommit', 'toolkitCommit']) {
    invariant(typeof source[key] === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source[key]), `Source ${key} must be a full lowercase Git SHA.`);
  }
  return immutable(source);
}

/** Seal a namespaced plan; adapters own semantic fields and should nest this object in legacy plan schemas. */
export function createPlan(input) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'Plan input is required.');
  for (const key of ['schemaVersion', 'kind', 'digest']) invariant(!Object.hasOwn(input, key), `Plan input reserves ${key}.`);
  const copied = immutable(input);
  validateSourceIdentity(copied.source);
  const payload = { schemaVersion: 1, kind: 'expo-release-plan', ...copied };
  return immutable({ ...payload, digest: hashIdentity(payload) });
}

/** Verify immutable plan integrity and optional expected provenance before using retained state. */
export function verifyPlan(plan, expectedSource = {}) {
  const copied = immutable(plan);
  invariant(copied.schemaVersion === 1 && copied.kind === 'expo-release-plan', 'Unsupported release plan schema.');
  validateSourceIdentity(copied.source);
  const { digest, ...payload } = copied;
  invariant(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) && hashIdentity(payload) === digest, 'Release plan digest differs.');
  for (const [key, expected] of Object.entries(expectedSource)) {
    invariant(Object.hasOwn(copied.source, key) && copied.source[key] === expected, `Release plan source ${key} differs.`);
  }
  return copied;
}
