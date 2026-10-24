/** @file Offline account migration planning, credential mapping, and resumable import execution with explicit source/target adapters. */

import { createHash } from 'node:crypto';
import { normalizeEmailCredential } from '../../src/utils/authCredentials';

/** Preparation only: no database, credentials, environment lookup, or Firebase I/O. */
export interface MigrationScope {
  installationId: string;
  sourceId: string;
  projectId: string;
}

export interface MigrationAccount {
  id: number;
  email: string;
  passwordHash: string;
  emailVerified: boolean;
  preservationDigest: string;
  providerLinked?: boolean;
  disabled?: boolean;
}

export interface DestinationIdentity {
  uid: string;
  email?: string;
}

export type MigrationHold = 'invalid_id' | 'duplicate_id' | 'invalid_email' |
  'email_collision' | 'unsupported_hash' | 'invalid_state' | 'existing_link' |
  'disabled' | 'destination_collision';

export interface MigrationRecord {
  ordinal: number;
  userId: number | null;
  uid: string | null;
  sourceDigest: string;
  holds: MigrationHold[];
}

export interface MigrationPlan {
  version: 1;
  scope: MigrationScope;
  digest: string;
  records: MigrationRecord[];
  summary: {
    accounts: number;
    eligible: number;
    held: number;
    verified: number;
    unverified: number;
    hashFormats: Record<string, number>;
  };
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const BCRYPT_PATTERN = /^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/;

function checkedScope(scope: MigrationScope): MigrationScope {
  // IDs are operator-chosen stable identifiers, never URLs containing credentials.
  for (const value of [scope.installationId, scope.sourceId, scope.projectId]) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,99}$/.test(value)) {
      throw new Error('Invalid migration scope');
    }
  }
  return { installationId: scope.installationId, sourceId: scope.sourceId, projectId: scope.projectId };
}

/** Derive a stable destination UID from installation, source, project and positive SQL user ID; reject invalid scope. */
export function migrationUid(scope: MigrationScope, userId: number): string {
  checkedScope(scope);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid application identity');
  return `cal_${digest([scope.installationId, scope.sourceId, scope.projectId, userId])}`;
}

function sourceDigest(account: MigrationAccount): string {
  return digest([account.id, account.email, account.passwordHash, account.emailVerified,
    account.preservationDigest, account.providerLinked ?? false, account.disabled ?? false]);
}

/** Output deliberately excludes emails, password hashes, health data, and provider responses. */
export function planFirebaseMigration(
  requestedScope: MigrationScope,
  accounts: MigrationAccount[],
  destination: DestinationIdentity[]
): MigrationPlan {
  const scope = checkedScope(requestedScope);
  const ids = new Map<number, number>();
  const emails = new Map<string, number>();
  const destinationUids = new Set(destination.map((row) => row.uid));
  const destinationEmails = new Set(destination.map((row) => normalizeEmailCredential(row.email)).filter(Boolean));
  for (const account of accounts) {
    ids.set(account.id, (ids.get(account.id) ?? 0) + 1);
    const email = normalizeEmailCredential(account.email);
    if (email) emails.set(email, (emails.get(email) ?? 0) + 1);
  }
  const hashFormats: Record<string, number> = {};
  const records = accounts.map((account, ordinal): MigrationRecord => {
    const holds: MigrationHold[] = [];
    const validId = Number.isSafeInteger(account.id) && account.id > 0;
    const email = normalizeEmailCredential(account.email);
    const validHash = typeof account.passwordHash === 'string' && BCRYPT_PATTERN.test(account.passwordHash);
    const hashFormat = validHash ? account.passwordHash.slice(0, 4) : 'unsupported';
    hashFormats[hashFormat] = (hashFormats[hashFormat] ?? 0) + 1;
    const uid = validId ? migrationUid(scope, account.id) : null;
    if (!validId) holds.push('invalid_id');
    if ((ids.get(account.id) ?? 0) > 1) holds.push('duplicate_id');
    if (!email) holds.push('invalid_email');
    if (email && (emails.get(email) ?? 0) > 1) holds.push('email_collision');
    if (!validHash) holds.push('unsupported_hash');
    if (typeof account.emailVerified !== 'boolean' ||
        !/^[a-f0-9]{64}$/.test(account.preservationDigest) ||
        (account.providerLinked !== undefined && typeof account.providerLinked !== 'boolean') ||
        (account.disabled !== undefined && typeof account.disabled !== 'boolean')) holds.push('invalid_state');
    if (account.providerLinked) holds.push('existing_link');
    if (account.disabled) holds.push('disabled');
    if ((uid && destinationUids.has(uid)) || (email && destinationEmails.has(email))) {
      holds.push('destination_collision');
    }
    return { ordinal, userId: validId ? account.id : null, uid, sourceDigest: sourceDigest(account), holds };
  });
  const held = records.filter((row) => row.holds.length > 0).length;
  return {
    version: 1, scope, digest: digest([scope, records]), records,
    summary: {
      accounts: records.length, eligible: records.length - held, held,
      verified: accounts.filter((row) => row.emailVerified === true).length,
      unverified: accounts.filter((row) => row.emailVerified === false).length,
      hashFormats
    }
  };
}

export type ImportState = 'pending' | 'in_flight' | 'imported' | 'rejected';
export interface MigrationCheckpoint {
  version: 1;
  planDigest: string;
  states: ImportState[];
}

export interface BcryptImportRecord {
  uid: string;
  email: string;
  emailVerified: boolean;
  passwordHash: Buffer;
}

/** A failed/ambiguous call must never be retried as a blind upsert. */
export interface MigrationDestination {
  projectId: string;
  /** Check every proposed UID/email against the frozen destination; any collision must hold the batch. */
  findCollisions(records: Array<{ uid: string; email: string }>): Promise<boolean>;
  /** Import encoded bcrypt credentials and return indexed outcomes; callers must persist in-flight state before invoking. */
  importUsers(records: BcryptImportRecord[], options: { hash: { algorithm: 'BCRYPT' } }): Promise<{
    successCount: number;
    failureCount: number;
    errors: Array<{ index: number }>;
  }>;
}

/** Bind a pending checkpoint to this exact plan digest and source-record order. */
export function initialMigrationCheckpoint(plan: MigrationPlan): MigrationCheckpoint {
  return { version: 1, planDigest: plan.digest, states: plan.records.map(() => 'pending') };
}

export interface MigrationRunOptions {
  // Omission is always a dry run. Production wiring must supply its own exclusive lease/freeze.
  apply?: boolean;
  batchSize?: number;
  checkpoint: MigrationCheckpoint;
  saveCheckpoint: (checkpoint: MigrationCheckpoint) => Promise<void>;
  readSource: () => Promise<MigrationAccount[]>;
  destination: MigrationDestination;
}

/**
 * Preparation engine for an exclusively held source/destination. The caller must prevent all
 * competing identity writers for the entire run; Firebase import has no create-only precondition.
 * No runtime/CLI apply adapter is shipped until that operator boundary is implemented and rehearsed.
 */
export async function runFirebaseMigration(plan: MigrationPlan, options: MigrationRunOptions): Promise<MigrationCheckpoint> {
  const size = options.batchSize ?? 100;
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('Invalid migration batch size');
  if (plan.version !== 1 || plan.digest !== digest([checkedScope(plan.scope), plan.records]) ||
      options.destination.projectId !== plan.scope.projectId) throw new Error('Migration identity mismatch');
  const checkpoint = structuredClone(options.checkpoint);
  if (checkpoint.version !== 1 || checkpoint.planDigest !== plan.digest ||
      checkpoint.states.length !== plan.records.length ||
      checkpoint.states.some((state) => !['pending', 'in_flight', 'imported', 'rejected'].includes(state))) {
    throw new Error('Invalid migration checkpoint');
  }
  if (plan.records.some((row) => row.holds.length)) throw new Error('Migration contains held accounts');
  if (checkpoint.states.includes('in_flight')) throw new Error('Ambiguous import requires reconciliation');
  if (checkpoint.states.includes('rejected')) throw new Error('Rejected import requires a reviewed recovery plan');
  // Even a dry run detects changed source data, without sending credential material anywhere.
  const readUnchangedSource = async () => {
    let accounts: MigrationAccount[];
    try { accounts = await options.readSource(); } catch { throw new Error('Migration source unavailable'); }
    const current = planFirebaseMigration(plan.scope, accounts, []);
    if (current.digest !== plan.digest) throw new Error('Migration source changed');
    return accounts;
  };
  const save = async () => {
    try { await options.saveCheckpoint(structuredClone(checkpoint)); } catch {
      throw new Error('Migration checkpoint persistence failed; reconcile before retrying');
    }
  };
  await readUnchangedSource();
  if (!options.apply) return checkpoint;
  for (let offset = 0; offset < plan.records.length; offset += size) {
    const pending = plan.records.slice(offset, offset + size).filter((row) => checkpoint.states[row.ordinal] === 'pending');
    if (!pending.length) continue;
    const accounts = await readUnchangedSource();
    const batch = pending.map((row): BcryptImportRecord => ({
      uid: row.uid!, email: normalizeEmailCredential(accounts[row.ordinal].email)!,
      emailVerified: accounts[row.ordinal].emailVerified,
      // Encoded bcrypt bytes, NOT base64-decoded bytes; no separate salt/cost parameters.
      passwordHash: Buffer.from(accounts[row.ordinal].passwordHash, 'utf8')
    }));
    let collision: boolean;
    try {
      collision = await options.destination.findCollisions(batch.map(({ uid, email }) => ({ uid, email })));
    } catch { throw new Error('Migration destination inspection unavailable'); }
    if (collision !== false) {
      throw new Error('Destination collision; import stopped');
    }
    pending.forEach((row) => { checkpoint.states[row.ordinal] = 'in_flight'; });
    // Persist intent BEFORE the network mutation. A crash here deliberately requires reconciliation.
    await save();
    let result: Awaited<ReturnType<MigrationDestination['importUsers']>>;
    try {
      result = await options.destination.importUsers(batch, { hash: { algorithm: 'BCRYPT' } });
    } catch {
      throw new Error('Ambiguous import requires reconciliation');
    }
    if (!result || !Array.isArray(result.errors) || result.errors.some((error) => !error || typeof error !== 'object')) {
      throw new Error('Ambiguous import requires reconciliation');
    }
    const failed = new Set(result.errors.map((error) => error.index));
    if (!Number.isInteger(result.successCount) || !Number.isInteger(result.failureCount) ||
        result.successCount < 0 || result.failureCount < 0 ||
        result.successCount + result.failureCount !== batch.length ||
        result.failureCount !== result.errors.length || failed.size !== result.errors.length ||
        [...failed].some((index) => !Number.isInteger(index) || index < 0 || index >= batch.length)) {
      throw new Error('Ambiguous import requires reconciliation');
    }
    pending.forEach((row, index) => { checkpoint.states[row.ordinal] = failed.has(index) ? 'rejected' : 'imported'; });
    await save();
    if (failed.size) throw new Error('Partial import requires a reviewed recovery plan');
  }
  return checkpoint;
}
