/** @file Regression coverage for release acceptance: repository plan encodes the lean single-user pre-release policy. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_ACCEPTANCE_PLAN_PATH,
  RELEASE_ACCEPTANCE_PLAN_SCHEMA_VERSION,
  RELEASE_ACCEPTANCE_SCOPES,
  normalizeReleaseAcceptanceScopes,
  parseReleaseAcceptanceArgs,
  requirementsForReleaseScopes,
  runReleaseAcceptanceCli,
  validateReleaseAcceptancePlan,
} from './release-acceptance.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryPlan = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, RELEASE_ACCEPTANCE_PLAN_PATH), 'utf8'),
);
const clonePlan = () => structuredClone(repositoryPlan);

test('repository plan encodes the lean single-user pre-release policy', () => {
  const result = validateReleaseAcceptancePlan(repositoryPlan, { repositoryRoot });

  assert.deepEqual(result.errors, []);
  assert.equal(repositoryPlan.schemaVersion, RELEASE_ACCEPTANCE_PLAN_SCHEMA_VERSION);
  assert.equal(repositoryPlan.profile, 'single-user-pre-release');
  assert.deepEqual(repositoryPlan.releaseScopes, RELEASE_ACCEPTANCE_SCOPES);
  assert.equal(repositoryPlan.policy.pullRequestChecks, 'affected-only');
  assert.equal(repositoryPlan.policy.externalReleaseApproval, 'owner-discretion');
  assert.equal(repositoryPlan.policy.retainedEvidenceRequired, false);
  assert.ok(result.automatic.length > 0);
  assert.ok(result.manual.length > 0);
});

test('dependency audits are maintenance checks rather than pull-request requirements', () => {
  const audit = repositoryPlan.automaticRequirements.find((item) => item.id === 'dependency-audit');

  assert.equal(audit.trigger, 'schedule-and-manual');
  assert.deepEqual(audit.workflowPaths, ['.github/workflows/dependency-audit.yml']);
  assert.deepEqual(audit.jobIds, ['production-audit']);
});

test('plan rejects retired blocking, receipt, and evidence contracts', () => {
  const plan = clonePlan();
  plan.candidateContract = { source: 'pull-request-head' };
  plan.manualCapabilities[0].retainedArtifact = { retentionDays: 90 };
  plan.automaticRequirements[0].blocksImplementation = true;

  const result = validateReleaseAcceptancePlan(plan, { repositoryRoot });

  assert.ok(result.errors.some((error) => error.includes('unexpected fields: candidateContract')));
  assert.ok(result.errors.some((error) => error.includes('retired evidence or blocking field candidateContract')));
  assert.ok(result.errors.some((error) => error.includes('retired evidence or blocking field retainedArtifact')));
  assert.ok(result.errors.some((error) => error.includes('retired evidence or blocking field blocksImplementation')));
});

test('plan rejects unknown, duplicate, and non-canonical release scopes', () => {
  assert.deepEqual(
    normalizeReleaseAcceptanceScopes(['server-web', 'native']),
    ['server-web', 'native'],
  );
  assert.deepEqual(
    normalizeReleaseAcceptanceScopes(['native', 'server-web']),
    ['server-web', 'native'],
  );
  assert.equal(normalizeReleaseAcceptanceScopes(['server-web', 'server-web']), null);
  assert.equal(normalizeReleaseAcceptanceScopes(['unknown']), null);

  const plan = clonePlan();
  plan.automaticRequirements[0].releaseScopes = ['native', 'server-web'];
  const result = validateReleaseAcceptancePlan(plan, { repositoryRoot });
  assert.ok(result.errors.some((error) => error.includes('canonical scope order')));
});

test('plan binds every named job to an existing workflow', () => {
  const plan = clonePlan();
  plan.manualCapabilities[0].jobIds = ['missing-job'];
  plan.automaticRequirements[0].workflowPaths = ['.github/workflows/missing.yml'];

  const result = validateReleaseAcceptancePlan(plan, { repositoryRoot });

  assert.ok(result.errors.some((error) => error.includes('does not exist')));
  assert.ok(result.errors.some((error) => error.includes('missing-job')));
});

test('manual capabilities in mixed workflows are dispatch-only', () => {
  const manualBuildJobs = repositoryPlan.manualCapabilities
    .filter((capability) => capability.workflowPath.endsWith('/builds.yml'))
    .flatMap((capability) => capability.jobIds);
  assert.ok(manualBuildJobs.length > 0);

  const result = validateReleaseAcceptancePlan(repositoryPlan, { repositoryRoot });
  assert.equal(result.errors.some((error) => error.includes('workflow_dispatch-only')), false);
});

test('requirements select automatic and optional capabilities by release scope', () => {
  const server = requirementsForReleaseScopes(repositoryPlan, ['server-web']);
  const native = requirementsForReleaseScopes(repositoryPlan, ['native']);

  assert.ok(server.some((item) => item.id === 'production-container'));
  assert.ok(server.some((item) => item.id === 'exhaustive-web-regression'));
  assert.ok(native.some((item) => item.id === 'native-emulator-and-upgrade'));
  assert.equal(native.some((item) => item.id === 'production-container'), false);
});

test('CLI supports only static policy verification', () => {
  assert.deepEqual(parseReleaseAcceptanceArgs([]), { command: 'verify', help: false });
  assert.deepEqual(
    parseReleaseAcceptanceArgs(['verify', '--help']),
    { command: 'verify', help: true },
  );
  assert.throws(
    () => parseReleaseAcceptanceArgs(['verify', '--external-launch']),
    /Unknown release acceptance option/,
  );
  assert.throws(
    () => runReleaseAcceptanceCli(['hosted-result'], { repositoryRoot }),
    /Unknown release acceptance command/,
  );
});

test('CLI validates policy without creating evidence', () => {
  const result = runReleaseAcceptanceCli(['verify'], { repositoryRoot });
  assert.equal(result.plan.profile, 'single-user-pre-release');
  assert.ok(result.automatic.length > 0);
  assert.ok(result.manual.length > 0);
});
