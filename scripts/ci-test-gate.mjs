/** @file Enforces selected backend, mobile/API, and MCP App/plugin test jobs before allowing a PR merge. */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Require successful selected jobs, including API-only runs; reject missing selections and failed classification. */
export function verifyRequiredTests(needs) {
  if (needs?.changes?.result !== 'success') throw new Error('Test classification did not succeed.');
  const outputs = needs.changes.outputs ?? {};
  for (const surface of ['backend', 'mobile', 'api', 'mcp']) {
    if (!['true', 'false'].includes(outputs[surface])) throw new Error(`Missing test selection for ${surface}.`);
  }
  for (const surface of ['backend', 'mobile', 'mcp']) {
    const selected = outputs[surface] === 'true' || (surface === 'mobile' && outputs.api === 'true');
    const result = needs[`${surface}-tests`]?.result;
    if (result !== 'success' && !(!selected && result === 'skipped')) {
      throw new Error(`${surface} tests did not succeed (${result ?? 'missing'}).`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    verifyRequiredTests(JSON.parse(process.env.TEST_JOB_RESULTS ?? '{}'));
    console.log('All selected test suites passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
