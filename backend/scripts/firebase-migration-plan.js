#!/usr/bin/env node
/** @file Reads a PostgreSQL export and produces the offline Firebase migration plan without contacting production services. */

'use strict';

// Offline inventory only. Deliberately no --apply, database connection, ADC, or Firebase client.
const fs = require('node:fs');
const { planFirebaseMigration } = require('./lib/firebaseMigration');

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node -r ts-node/register scripts/firebase-migration-plan.js <inventory.json>');
    console.log('Offline dry run only; reads scope, accounts, and destination from an operator-supplied inventory.');
    return;
  }
  if (args.length !== 1 || args[0].startsWith('-')) throw new Error('Invalid arguments');
  const input = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  if (!input || !input.scope || !Array.isArray(input.accounts) || !Array.isArray(input.destination) ||
      input.accounts.some((row) => !row || typeof row !== 'object') ||
      input.destination.some((row) => !row || typeof row.uid !== 'string' ||
        (row.email !== undefined && typeof row.email !== 'string'))) throw new Error('Invalid inventory');
  const plan = planFirebaseMigration(input.scope, input.accounts, input.destination);
  console.log(JSON.stringify({ mode: 'offline-dry-run', ...plan }, null, 2));
  if (plan.summary.held) process.exitCode = 2;
}

try { main(process.argv.slice(2)); } catch {
  // JSON parse and filesystem errors can include sensitive input/path content.
  console.error('Migration inventory rejected; check the documented input format. No writes were attempted.');
  process.exitCode = 1;
}
