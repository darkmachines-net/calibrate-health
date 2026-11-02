/** @file Guard the three required PR checks, fail-closed jobs and reuse of the exact production export. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const directory = new URL('../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(fs.readdirSync(directory).filter(file => file.endsWith('.yml'))
  .map(file => [file, parse(fs.readFileSync(new URL(file, directory), 'utf8'))]));
const workflow = workflows['ci.yml'];

test('every PR reports exactly Lint, Build and Tests without classification or matrix check noise', () => {
  const prWorkflows = Object.entries(workflows).filter(([, value]) => Object.hasOwn(value.on, 'pull_request'));
  assert.deepEqual(prWorkflows.map(([file]) => file), ['ci.yml']);
  assert.equal(workflow.on.pull_request, null, 'path filters can leave required checks pending');
  assert.deepEqual(Object.keys(workflow.jobs), ['lint', 'build', 'tests']);
  assert.deepEqual(Object.values(workflow.jobs).map(job => job.name), ['Lint', 'Build', 'Tests']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.if, undefined, 'required checks must run on every PR');
    assert.equal(job.strategy, undefined);
    assert.equal(job['continue-on-error'], undefined);
    assert.ok(job['timeout-minutes'] > 0);
    for (const step of job.steps) {
      assert.equal(step['continue-on-error'], undefined);
      assert.equal(step.if, undefined, 'core validation must not silently skip');
    }
  }
});

test('Tests requires Build and consumes its export without another web build', () => {
  const { build, tests } = workflow.jobs;
  assert.equal(tests.needs, 'build');
  const upload = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = tests.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, '.');
  assert.match(upload.with.path, /backend\/dist\//);
  assert.match(upload.with.path, /mobile\/dist\//);
  assert.equal(upload.with['include-hidden-files'], true);
  assert.equal(upload.with['if-no-files-found'], 'error');
  const commands = tests.steps.map(step => step.run ?? '').join('\n');
  assert.match(commands, /npm test/);
  assert.match(commands, /npm --prefix backend run db:migrate/);
  assert.match(commands, /npm run test:release/);
  assert.match(commands, /test:expo-web:release/);
  assert.match(commands, /playwright\/test\/cli.js test .*release-smoke.spec.ts/);
  assert.doesNotMatch(commands, /build:expo-web|build:web|expo-web-playwright.mjs|test:expo-web:smoke/);
  assert.ok(tests.services.postgres);
  assert.ok(tests.env.CALIBRATE_AUTH_TEST_DATABASE_URL);
});

test('native builds and operational rehearsals remain available outside pull requests', () => {
  for (const name of ['builds', 'database-upgrade', 'container-scan', 'dependency-audit']) {
    assert.ok(Object.hasOwn(workflows[`${name}.yml`].on, 'workflow_dispatch'));
    assert.equal(workflows[`${name}.yml`].on.pull_request, undefined);
  }
  for (const id of ['mobile-build', 'ios-build', 'wear-build', 'android-emulator-e2e', 'native-package-upgrade']) {
    assert.ok(workflows['builds.yml'].jobs[id]);
  }
  assert.ok(workflows['database-upgrade.yml'].jobs['release-upgrade-rollback']);
  assert.ok(workflows['container-scan.yml'].on.schedule.length);
});
