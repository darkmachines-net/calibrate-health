import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Require successful tests for every surface selected by the PR classifier. */
export function verifyRequiredTests(needs) {
  if (needs?.changes?.result !== 'success') throw new Error('Test classification did not succeed.');
  for (const surface of ['backend', 'mobile']) {
    const selected = needs.changes.outputs?.[surface];
    const result = needs[`${surface}-tests`]?.result;
    if (selected !== 'true' && selected !== 'false') throw new Error(`Missing test selection for ${surface}.`);
    if (result !== 'success' && !(selected === 'false' && result === 'skipped')) {
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
