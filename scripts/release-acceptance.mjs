/** @file Release-scope classification and validation of the repository-owned acceptance plan. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RELEASE_ACCEPTANCE_PLAN_SCHEMA_VERSION = 4;
export const RELEASE_ACCEPTANCE_PLAN_PATH = 'quality/release-acceptance-plan.json';
export const RELEASE_ACCEPTANCE_SCOPES = Object.freeze(['server-web', 'ota', 'native']);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_FIELDS = Object.freeze([
  'schemaVersion',
  'profile',
  'protocolPath',
  'releaseManifestPath',
  'releaseScopes',
  'policy',
  'automaticRequirements',
  'manualCapabilities',
]);
const POLICY_FIELDS = Object.freeze([
  'pullRequestChecks',
  'externalReleaseApproval',
  'retainedEvidenceRequired',
]);
const AUTOMATIC_FIELDS = Object.freeze([
  'id',
  'title',
  'releaseScopes',
  'trigger',
  'workflowPaths',
  'jobIds',
]);
const MANUAL_FIELDS = Object.freeze([
  'id',
  'title',
  'releaseScopes',
  'workflowPath',
  'jobIds',
]);
const AUTOMATIC_TRIGGERS = new Set([
  'affected-pull-request',
  'migration-change',
  'schedule-and-manual',
  'affected-pull-request-and-release',
  'release',
]);
const RETIRED_FIELDS = new Set([
  'blocksImplementation',
  'blocksExternalLaunch',
  'candidateCommit',
  'candidateContract',
  'completedOn',
  'evidence',
  'evidenceCommit',
  'evidenceCommitContract',
  'execution',
  'outcome',
  'receipt',
  'retainedArtifact',
  'runId',
  'sha256',
  'sourceCommit',
  'status',
]);

function hasExactFields(value, expected, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const missing = wanted.filter((field) => !actual.includes(field));
  const unexpected = actual.filter((field) => !wanted.includes(field));
  if (missing.length) errors.push(`${label} is missing fields: ${missing.join(', ')}.`);
  if (unexpected.length) errors.push(`${label} has unexpected fields: ${unexpected.join(', ')}.`);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validates and orders a nonempty unique set of supported release scopes, otherwise null. */
export function normalizeReleaseAcceptanceScopes(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.some((scope) => typeof scope !== 'string' || !RELEASE_ACCEPTANCE_SCOPES.includes(scope))) {
    return null;
  }
  if (new Set(value).size !== value.length) return null;
  return RELEASE_ACCEPTANCE_SCOPES.filter((scope) => value.includes(scope));
}

function validateReleaseScopes(value, label, errors, expected = null) {
  const normalized = normalizeReleaseAcceptanceScopes(value);
  if (normalized === null) {
    errors.push(`${label} must contain unique supported scopes: ${RELEASE_ACCEPTANCE_SCOPES.join(', ')}.`);
    return;
  }
  if (JSON.stringify(value) !== JSON.stringify(normalized)) {
    errors.push(`${label} must use canonical scope order: ${RELEASE_ACCEPTANCE_SCOPES.join(', ')}.`);
  }
  if (expected && JSON.stringify(normalized) !== JSON.stringify(expected)) {
    errors.push(`${label} must define exactly: ${expected.join(', ')}.`);
  }
}

function repositoryPath(value) {
  if (!isNonEmptyString(value) || path.isAbsolute(value)) return null;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function readRepositoryFile(relativePath, label, root, errors, readFile) {
  const normalized = repositoryPath(relativePath);
  if (!normalized) {
    errors.push(`${label} must stay within the repository.`);
    return null;
  }
  try {
    const content = readFile(path.join(root, normalized), 'utf8');
    if (!content.length) errors.push(`${label} must be non-empty: ${normalized}.`);
    return content;
  } catch {
    errors.push(`${label} does not exist: ${normalized}.`);
    return null;
  }
}

function rejectRetiredFields(value, errors) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (RETIRED_FIELDS.has(key)) {
      errors.push(`Release acceptance plan must not contain retired evidence or blocking field ${key}.`);
    }
    if (nested && typeof nested === 'object') rejectRetiredFields(nested, errors);
  }
}

function workflowJob(workflow, jobId) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(jobId ?? '')) return null;
  return workflow.match(new RegExp(`\\n  ${jobId}:\\n[\\s\\S]*?(?=\\n  [a-z0-9][a-z0-9_-]*:|$)`))?.[0] ?? null;
}

function stringList(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !isNonEmptyString(item))) {
    errors.push(`${label} must be a non-empty string array.`);
    return [];
  }
  if (new Set(value).size !== value.length) errors.push(`${label} must be unique.`);
  return value;
}

function validateWorkflowJobs(workflowPaths, jobIds, label, context, manualOnly = false) {
  const workflows = [];
  for (const workflowPath of workflowPaths) {
    const content = readRepositoryFile(
      workflowPath,
      `${label} workflow`,
      context.root,
      context.errors,
      context.readFile,
    );
    if (content) workflows.push(content);
  }
  for (const jobId of jobIds) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(jobId)) {
      context.errors.push(`${label} job id is invalid: ${jobId}.`);
      continue;
    }
    const matches = workflows
      .map((workflow) => ({ workflow, job: workflowJob(workflow, jobId) }))
      .filter((match) => match.job);
    if (matches.length === 0) {
      context.errors.push(`${label} job does not exist in its declared workflow(s): ${jobId}.`);
      continue;
    }
    if (!manualOnly) continue;
    for (const match of matches) {
      const acceptsPullRequests = /(^|\n)\s+pull_request:/.test(match.workflow);
      if (acceptsPullRequests && !match.job.includes("github.event_name == 'workflow_dispatch'")) {
        context.errors.push(`${label} job ${jobId} must be workflow_dispatch-only.`);
      }
    }
  }
}

/** Selects automatic and manual requirements intersecting the requested release scopes. */
export function requirementsForReleaseScopes(plan, releaseScopes) {
  const normalized = normalizeReleaseAcceptanceScopes(releaseScopes) ?? [...RELEASE_ACCEPTANCE_SCOPES];
  return [...(plan?.automaticRequirements ?? []), ...(plan?.manualCapabilities ?? [])]
    .filter((item) => item.releaseScopes?.some((scope) => normalized.includes(scope)));
}

/** Validates the current acceptance schema, referenced inputs, requirements, and retained evidence. */
export function validateReleaseAcceptancePlan(plan, options = {}) {
  const context = {
    root: options.repositoryRoot ?? repositoryRoot,
    readFile: options.readFileSync ?? fs.readFileSync,
    errors: [],
  };
  const { errors } = context;
  hasExactFields(plan, PLAN_FIELDS, 'Release acceptance plan', errors);
  rejectRetiredFields(plan, errors);
  if (plan?.schemaVersion !== RELEASE_ACCEPTANCE_PLAN_SCHEMA_VERSION) {
    errors.push(`Release acceptance plan schemaVersion must be ${RELEASE_ACCEPTANCE_PLAN_SCHEMA_VERSION}.`);
  }
  if (plan?.profile !== 'single-user-pre-release') {
    errors.push('Release acceptance profile must be single-user-pre-release.');
  }
  const protocol = readRepositoryFile(
    plan?.protocolPath,
    'Release acceptance protocol',
    context.root,
    errors,
    context.readFile,
  );
  readRepositoryFile(plan?.releaseManifestPath, 'Release manifest', context.root, errors, context.readFile);
  if (protocol && !/single-user pre-release/i.test(protocol)) {
    errors.push('Release acceptance protocol must explain the single-user pre-release policy.');
  }
  validateReleaseScopes(
    plan?.releaseScopes,
    'Release acceptance plan releaseScopes',
    errors,
    [...RELEASE_ACCEPTANCE_SCOPES],
  );

  hasExactFields(plan?.policy, POLICY_FIELDS, 'Release acceptance policy', errors);
  if (plan?.policy?.pullRequestChecks !== 'affected-only') {
    errors.push('Release acceptance policy pullRequestChecks must be affected-only.');
  }
  if (plan?.policy?.externalReleaseApproval !== 'owner-discretion') {
    errors.push('Release acceptance policy externalReleaseApproval must be owner-discretion.');
  }
  if (plan?.policy?.retainedEvidenceRequired !== false) {
    errors.push('Release acceptance policy retainedEvidenceRequired must be false.');
  }

  const automatic = Array.isArray(plan?.automaticRequirements) ? plan.automaticRequirements : [];
  const manual = Array.isArray(plan?.manualCapabilities) ? plan.manualCapabilities : [];
  if (automatic.length === 0) errors.push('Release acceptance plan must define automatic requirements.');
  if (manual.length === 0) errors.push('Release acceptance plan must define manual capabilities.');
  const ids = new Set();

  for (const item of automatic) {
    const label = `Automatic requirement ${item?.id ?? 'unknown'}`;
    hasExactFields(item, AUTOMATIC_FIELDS, label, errors);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item?.id ?? '')) errors.push(`${label} id is invalid.`);
    if (ids.has(item?.id)) errors.push(`${label} id is duplicated.`);
    ids.add(item?.id);
    if (!isNonEmptyString(item?.title)) errors.push(`${label} must have a title.`);
    validateReleaseScopes(item?.releaseScopes, `${label} releaseScopes`, errors);
    if (!AUTOMATIC_TRIGGERS.has(item?.trigger)) errors.push(`${label} trigger is invalid.`);
    const workflowPaths = stringList(item?.workflowPaths, `${label} workflowPaths`, errors);
    const jobIds = stringList(item?.jobIds, `${label} jobIds`, errors);
    validateWorkflowJobs(workflowPaths, jobIds, label, context);
  }

  for (const item of manual) {
    const label = `Manual capability ${item?.id ?? 'unknown'}`;
    hasExactFields(item, MANUAL_FIELDS, label, errors);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item?.id ?? '')) errors.push(`${label} id is invalid.`);
    if (ids.has(item?.id)) errors.push(`${label} id is duplicated.`);
    ids.add(item?.id);
    if (!isNonEmptyString(item?.title)) errors.push(`${label} must have a title.`);
    validateReleaseScopes(item?.releaseScopes, `${label} releaseScopes`, errors);
    const workflowPaths = isNonEmptyString(item?.workflowPath) ? [item.workflowPath] : [];
    if (workflowPaths.length === 0) errors.push(`${label} workflowPath must be non-empty.`);
    const jobIds = stringList(item?.jobIds, `${label} jobIds`, errors);
    validateWorkflowJobs(workflowPaths, jobIds, label, context, true);
  }

  for (const scope of RELEASE_ACCEPTANCE_SCOPES) {
    if (!automatic.some((item) => item.releaseScopes?.includes(scope))) {
      errors.push(`Release scope ${scope} must have an automatic safety requirement.`);
    }
    if (!manual.some((item) => item.releaseScopes?.includes(scope))) {
      errors.push(`Release scope ${scope} must have an optional manual capability.`);
    }
  }
  return { errors, automatic, manual };
}

/** Parses acceptance verification arguments and rejects unsupported options. */
export function parseReleaseAcceptanceArgs(argv) {
  const values = {
    command: argv[0] && !argv[0].startsWith('--') ? argv[0] : 'verify',
    help: false,
  };
  const start = values.command === 'verify' && argv[0]?.startsWith('--') ? 0 : 1;
  for (let index = start; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') values.help = true;
    else throw new Error(`Unknown release acceptance option: ${option}`);
  }
  return values;
}

/** Loads and validates the repository acceptance plan, failing when any current contract requirement is invalid. */
export function runReleaseAcceptanceCli(argv = process.argv.slice(2), options = {}) {
  const root = options.repositoryRoot ?? repositoryRoot;
  const args = parseReleaseAcceptanceArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/release-acceptance.mjs verify\n');
    return { help: true };
  }
  if (args.command !== 'verify') throw new Error(`Unknown release acceptance command: ${args.command}`);
  const plan = JSON.parse(fs.readFileSync(path.join(root, RELEASE_ACCEPTANCE_PLAN_PATH), 'utf8'));
  const validation = validateReleaseAcceptancePlan(plan, { repositoryRoot: root });
  if (validation.errors.length) {
    throw new Error(`Release acceptance plan is invalid:\n- ${validation.errors.join('\n- ')}`);
  }
  process.stdout.write('Single-user pre-release acceptance policy is valid.\n');
  process.stdout.write(`Optional manual capabilities: ${validation.manual.map((item) => item.id).join(', ')}.\n`);
  return { plan, automatic: validation.automatic, manual: validation.manual };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runReleaseAcceptanceCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
