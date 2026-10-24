/** @file Trusted workflow_run event validation for read-only release requests and protected handlers. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.yml$/;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

function requireEqual(actual, expected, label) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label} does not match the protected request authority.`);
  }
}

function requirePositiveInteger(value, label) {
  const normalized = String(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new Error(`${label} is malformed.`);
  return normalized;
}

function requireString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is malformed.`);
  return value;
}

/** Validates workflow_run identity against the expected repository, request workflow, and protected handler source. */
export function verifyReleaseHandlerEvent(event, expected) {
  requireObject(event, 'workflow_run event');
  requireString(expected.repository, REPOSITORY_PATTERN, 'expected repository');
  requirePositiveInteger(expected.repositoryId, 'expected repository ID');
  requireString(expected.workflowPath, WORKFLOW_PATH_PATTERN, 'expected workflow path');
  requireString(expected.handlerSha, SHA_PATTERN, 'handler workflow SHA');
  requireEqual(expected.handlerRef, 'refs/heads/master', 'handler ref');

  const repository = requireObject(event.repository, 'event repository');
  const run = requireObject(event.workflow_run, 'workflow run');
  const runRepository = requireObject(run.repository, 'workflow run repository');
  const headRepository = requireObject(run.head_repository, 'workflow run head repository');
  const actor = requireObject(run.actor, 'workflow run actor');
  const triggeringActor = requireObject(run.triggering_actor, 'workflow run triggering actor');

  requireEqual(event.action, 'completed', 'workflow run action');
  requireEqual(run.conclusion, 'success', 'workflow run conclusion');
  requireEqual(run.event, 'workflow_dispatch', 'workflow run event');
  requireEqual(repository.full_name, expected.repository, 'event repository');
  requireEqual(repository.id, expected.repositoryId, 'event repository ID');
  requireEqual(runRepository.full_name, expected.repository, 'workflow run repository');
  requireEqual(runRepository.id, expected.repositoryId, 'workflow run repository ID');
  requireEqual(headRepository.full_name, expected.repository, 'workflow run head repository');
  requireEqual(headRepository.id, expected.repositoryId, 'workflow run head repository ID');
  requireEqual(run.path, expected.workflowPath, 'workflow path');
  requireEqual(run.head_branch, 'master', 'workflow run head branch');
  requireString(run.head_sha, SHA_PATTERN, 'workflow run head SHA');
  requireEqual(run.head_sha, expected.handlerSha, 'workflow run head SHA');
  requireEqual(actor.type, 'User', 'workflow run actor type');
  requireEqual(triggeringActor.type, 'User', 'workflow run triggering actor type');

  return Object.freeze({
    headBranch: run.head_branch,
    headSha: run.head_sha,
    runAttempt: requirePositiveInteger(run.run_attempt, 'workflow run attempt'),
    runId: requirePositiveInteger(run.id, 'workflow run ID')
  });
}

function parseArguments(args) {
  if (args[0] !== 'verify') throw new Error('Expected command: verify.');
  const allowed = new Set([
    '--event-file', '--workflow-path', '--repository', '--repository-id', '--handler-ref', '--handler-sha'
  ]);
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.has(option) || !value || value.startsWith('--')) {
      throw new Error(`Unknown or incomplete handler-event option: ${option ?? '(missing)'}.`);
    }
    if (Object.hasOwn(values, option)) throw new Error(`Duplicate handler-event option: ${option}.`);
    values[option] = value;
  }
  for (const option of allowed) {
    if (!values[option]) throw new Error(`${option} is required.`);
  }
  return values;
}

/** Reads a bounded regular workflow event file and verifies its exact handler/request identity. */
export function runReleaseHandlerEventCli(args = process.argv.slice(2)) {
  const values = parseArguments(args);
  const eventFile = path.resolve(values['--event-file']);
  const stat = fs.lstatSync(eventFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024) {
    throw new Error('Workflow event payload must be a regular JSON file of at most 1 MiB.');
  }
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  return verifyReleaseHandlerEvent(event, {
    workflowPath: values['--workflow-path'],
    repository: values['--repository'],
    repositoryId: values['--repository-id'],
    handlerRef: values['--handler-ref'],
    handlerSha: values['--handler-sha']
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runReleaseHandlerEventCli();
  } catch (error) {
    console.error(`[release-handler-event] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
