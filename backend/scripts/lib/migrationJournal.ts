/** @file Append-only, single-host migration journal with exclusive locks and fail-closed torn-record recovery. */

import fs from 'node:fs';
import { initialMigrationCheckpoint, MigrationCheckpoint, MigrationPlan } from './firebaseMigration';

function validateCheckpoint(value: MigrationCheckpoint, plan: MigrationPlan): void {
  if (value?.version !== 1 || value.planDigest !== plan.digest || !Array.isArray(value.states) ||
      value.states.length !== plan.records.length ||
      value.states.some((state) => !['pending', 'in_flight', 'imported', 'rejected'].includes(state))) {
    throw new Error('Invalid migration journal');
  }
}

function validateTransition(previous: MigrationCheckpoint, next: MigrationCheckpoint): void {
  for (let index = 0; index < previous.states.length; index += 1) {
    const before = previous.states[index];
    const after = next.states[index];
    if (before === after || (before === 'pending' && after === 'in_flight') ||
        (before === 'in_flight' && (after === 'imported' || after === 'rejected'))) continue;
    throw new Error('Migration journal cannot rewind or skip import intent');
  }
}

/**
 * Single-host append-only journal. A stale lock or torn record fails closed; never auto-steal it.
 * This serializes importer processes only, NOT SQL/Firebase writers. External freezes remain required.
 */
export async function withMigrationJournal<T>(
  journalPath: string,
  plan: MigrationPlan,
  work: (checkpoint: MigrationCheckpoint, save: (next: MigrationCheckpoint) => Promise<void>) => Promise<T>
): Promise<T> {
  const lockPath = `${journalPath}.lock`;
  let lock: number;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch {
    throw new Error('Migration journal locked or unavailable; reconcile before retrying');
  }
  let journal: number | undefined;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, planDigest: plan.digest }));
    fs.fsyncSync(lock);
    let created = false;
    try {
      journal = fs.openSync(journalPath, 'ax+', 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      journal = fs.openSync(journalPath, 'a+');
    }
    let current = initialMigrationCheckpoint(plan);
    const append = (value: MigrationCheckpoint) => {
      fs.writeFileSync(journal!, `${JSON.stringify(value)}\n`);
      fs.fsyncSync(journal!);
    };
    if (created) {
      append(current);
    } else {
      const content = fs.readFileSync(journal, 'utf8');
      if (!content || !content.endsWith('\n')) throw new Error('Incomplete migration journal; reconcile before retrying');
      const rows = content.slice(0, -1).split('\n');
      for (const row of rows) {
        let next: MigrationCheckpoint;
        try { next = JSON.parse(row) as MigrationCheckpoint; } catch {
          throw new Error('Invalid migration journal');
        }
        validateCheckpoint(next, plan);
        validateTransition(current, next);
        current = next;
      }
    }
    let failed = false;
    return await work(structuredClone(current), async (next) => {
      if (failed) throw new Error('Migration journal requires reconciliation');
      validateCheckpoint(next, plan);
      validateTransition(current, next);
      try { append(next); } catch {
        failed = true;
        throw new Error('Migration journal persistence failed; reconcile before retrying');
      }
      current = structuredClone(next);
    });
  } finally {
    if (journal !== undefined) fs.closeSync(journal);
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
