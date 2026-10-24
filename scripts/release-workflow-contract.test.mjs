/**
 * @file Verify release workflow authority, credential boundaries, and job
 * sequencing from repository sources without publishing or deploying anything.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { REQUIRED_CI } from './release-ci-gate.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDirectory = path.join(repositoryRoot, '.github', 'workflows');
/** Normalize workflow line endings for the same contract checks on Windows and Linux. */
const readWorkflow = (name) => readFileSync(path.join(workflowsDirectory, name), 'utf8')
  .replaceAll('\r\n', '\n');

const reviewedReleaseActionPins = new Map([
  ['actions/checkout', '11d5960a326750d5838078e36cf38b85af677262'],
  ['actions/setup-node', '49933ea5288caeca8642d1e84afbd3f7d6820020'],
  ['actions/setup-java', 'cf277c60eb25467037889841efdb72551f06f6c3'],
  ['actions/github-script', '3a2844b7e9c422d3c10d287c895573f7108da1b3'],
  ['actions/upload-artifact', 'ea165f8d65b6e75b540449e92b4886f43607fa02'],
  ['actions/download-artifact', 'd3f86a106a0bac45b974a628896c90dbdf5c8093'],
  ['actions/create-github-app-token', 'fee1f7d63c2ff003460e3d139729b119787bc349'],
  ['actions/attest', '508db95dd578ae2727ebd6217d5ba78e4fbda05d'],
  ['android-actions/setup-android', '9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407'],
  ['docker/setup-buildx-action', 'e468171a9de216ec08956ac3ada2f0791b6bd435'],
  ['docker/login-action', '184bdaa0721073962dff0199f1fb9940f07167d1'],
  ['docker/build-push-action', '263435318d21b8e681c14492fe198d362a7d2c83'],
  ['dorny/paths-filter', '0e4a8c6effa4802afeda77dc8d303f8176d7dfad']
]);

/** Require every external action to match its reviewed immutable commit. */
function assertReviewedReleaseActionPins(workflowName) {
  const workflow = readWorkflow(workflowName);
  for (const match of workflow.matchAll(/^\s*uses:\s+(\S+)/gm)) {
    const reference = match[1];
    if (reference.startsWith('./')) continue;
    const parsed = /^([^@\s]+)@([^@\s]+)$/.exec(reference);
    assert.ok(parsed, `${workflowName} external action must include an immutable reference: ${reference}`);
    const [, action, revision] = parsed;
    assert.match(revision, /^[0-9a-f]{40}$/, `${workflowName} must pin ${action} to a full commit SHA`);
    assert.equal(
      revision,
      reviewedReleaseActionPins.get(action),
      `${workflowName} must use the reviewed commit for ${action}`
    );
  }
}

/** Select one literal job block without allowing a test selector to act as a regex. */
function workflowJobBlock(workflow, jobName) {
  assert.match(jobName, /^[a-z0-9_-]+$/, 'workflow job selector must be a literal safe identifier');
  const match = workflow.match(new RegExp(`\\n  ${jobName}:\\n[\\s\\S]*?(?=\\n  [a-z0-9_-]+:|$)`));
  assert.ok(match, `workflow must define one ${jobName} job`);
  return match[0];
}

/** Read an explicit block-style permission map at the workflow or job indentation level. */
function workflowPermissions(block, indent) {
  const prefix = ' '.repeat(indent);
  const declaration = block.match(new RegExp(`^${prefix}permissions:([^\\n]*)`, 'm'));
  if (!declaration) return undefined;
  assert.equal(declaration[1].trim(), '', 'permissions must use an explicit block map');
  const entries = block.slice(declaration.index + declaration[0].length + 1)
    .match(new RegExp(`^(?:${prefix}  [a-z-]+: (?:read|write|none)\\n)+`));
  assert.ok(entries, 'permissions must declare literal read, write, or none scopes');
  return Object.fromEntries([...entries[0].matchAll(/([a-z-]+): (read|write|none)/g)]
    .map(([, scope, level]) => [scope, level]));
}

test('local reusable workflow callers cover every called job token permission', () => {
  const permissionRank = { none: 0, read: 1, write: 2 };
  const failures = [];
  for (const file of readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = readWorkflow(file);
    const defaults = workflowPermissions(workflow, 0);
    const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
    for (const [, jobName] of jobs.matchAll(/^ {2}([a-z0-9_-]+):$/gm)) {
      const caller = workflowJobBlock(workflow, jobName);
      const reference = caller.match(/^ {4}uses: \.\/\.github\/workflows\/([^\s]+)$/m);
      if (!reference) continue;
      const allowed = workflowPermissions(caller, 4) ?? defaults;
      assert.ok(allowed, `${file}/${jobName} must declare its token permissions`);
      const callee = readWorkflow(reference[1]);
      const calleeDefaults = workflowPermissions(callee, 0);
      const nestedJobs = callee.slice(callee.indexOf('\njobs:\n'));
      for (const [, nestedJobName] of nestedJobs.matchAll(/^ {2}([a-z0-9_-]+):$/gm)) {
        const requested = workflowPermissions(workflowJobBlock(callee, nestedJobName), 4)
          ?? calleeDefaults;
        assert.ok(requested, `${reference[1]}/${nestedJobName} must declare its token permissions`);
        for (const [scope, level] of Object.entries(requested)) {
          const permitted = allowed[scope] ?? 'none';
          if (permissionRank[level] > permissionRank[permitted]) {
            failures.push(`${file}/${jobName} -> ${reference[1]}/${nestedJobName}: ` +
              `${scope}: ${level} requested, ${permitted} allowed`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, [], 'Reusable workflows cannot increase caller token permissions');
});

test('Cut release reuses every required CI surface with explicit read-only candidate identity', () => {
  const release = readWorkflow('cut-release.yml');
  const finalize = workflowJobBlock(release, 'finalize');
  for (const [file, requiredNames] of Object.entries(REQUIRED_CI)) {
    const caller = workflowJobBlock(release, `candidate-${file.slice(0, -4)}`);
    const callee = readWorkflow(file);
    assert.deepEqual(workflowPermissions(caller, 4), { contents: 'read', 'pull-requests': 'read' });
    assert.match(caller, /needs: \[prepare, publish_candidate, release-validation\]/);
    assert.ok(caller.includes(`uses: ./.github/workflows/${file}`));
    assert.match(caller, /release_sha: \$\{\{ needs\.prepare\.outputs\.release_sha \}\}/);
    assert.match(caller, /source_sha: \$\{\{ needs\.prepare\.outputs\.source_sha \}\}/);
    assert.doesNotMatch(caller, /secrets:|environment:|write/);
    assert.ok(finalize.includes(`candidate-${file.slice(0, -4)}`));
    assert.match(callee, /workflow_call:[\s\S]*release_sha:[\s\S]*required: true[\s\S]*source_sha:[\s\S]*required: true/);
    assert.match(callee, /release-ci-gate\.mjs --verify-inputs/);
    assert.match(callee, /format\('candidate-\{0\}-\{1\}', github\.run_id, github\.run_attempt\)/);
    for (const name of requiredNames) {
      assert.ok(callee.includes(`    name: ${name}\u0024{{ inputs.release_sha && format(' [{0}]', inputs.release_sha) || '' }}`),
        `${file} must bind the gate's ${name} job name to the full candidate SHA`);
    }
  }
  assert.equal((finalize.match(/RELEASE_CI_RUN_ID: \$\{\{ github\.run_id \}\}/g) ?? []).length, 2);
  assert.equal((finalize.match(/RELEASE_CI_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/g) ?? []).length, 2);
  const buildDecision = workflowJobBlock(readWorkflow('builds.yml'), 'changes');
  assert.match(buildDecision, /if \[\[ "\$\{RELEASE_CANDIDATE\}" == "true" \]\]; then\n\s+release_config=true\n\s+elif/);
  assert.match(workflowJobBlock(readWorkflow('database-upgrade.yml'), 'changes'),
    /MIGRATIONS_CHANGED: \$\{\{ inputs\.release_sha == '' &&/);
});

/** Extract a named path filter from the repository's block-style workflow declarations. */
function workflowPathFilterBlock(job, filterName) {
  assert.match(filterName, /^[a-z_]+$/, 'workflow path filter selector must be a literal safe identifier');
  const match = job.match(
    new RegExp(`\\n            ${filterName}:\\n[\\s\\S]*?(?=\\n            [a-z_]+:|\\n\\n|$)`)
  );
  assert.ok(match, `workflow must define one ${filterName} path filter`);
  return match[0];
}

/** Collect the single-quoted path patterns declared by one workflow filter. */
function workflowPathFilterPaths(job, filterName) {
  return [...workflowPathFilterBlock(job, filterName).matchAll(/- '([^']+)'/g)]
    .map((match) => match[1]);
}

/** Match the star and double-star glob subset used by these path-filter contracts. */
function pathFilterPatternMatches(pattern, candidatePath) {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*');
  return new RegExp(`^${escaped}$`).test(candidatePath);
}

/** Evaluate positive and excluded path patterns under the filter's selected quantifier. */
function pathFilterMatches(job, filterName, candidatePath, predicateQuantifier = 'some') {
  const matches = workflowPathFilterPaths(job, filterName).map((pattern) => {
    const excluded = pattern.startsWith('!');
    const patternMatches = pathFilterPatternMatches(excluded ? pattern.slice(1) : pattern, candidatePath);
    return excluded ? !patternMatches : patternMatches;
  });
  if (predicateQuantifier === 'every') {
    return matches.every(Boolean);
  }
  assert.equal(predicateQuantifier, 'some');
  return matches.some(Boolean);
}

/** Require reviewed path classification and explicit job outputs for every expected category. */
function assertPathFilterOutputs(job, outputNames, stepId = 'filter', revision = 'v3') {
  assert.match(job, /pull-requests: read/);
  assert.ok(job.includes(`uses: dorny/paths-filter@${revision}`));
  for (const outputName of outputNames) {
    assert.match(outputName, /^[a-z_]+$/);
    const expression = outputName + ': ' + '${{ steps.' + stepId + '.outputs.' + outputName + ' }}';
    assert.ok(job.includes(expression), `classifier must publish ${expression}`);
  }
}

test('credentialed release workflows pin external actions and the EAS CLI immutably', () => {
  for (const workflowName of [
    'cut-release.yml',
    'publish-release.yml',
    'container.yml',
    'cut-release-request.yml',
    'cut-release-handler.yml',
    'publish-release-request.yml',
    'publish-release-handler.yml',
    'container-request.yml',
    'container-handler.yml',
    'expo-ota-update.yml',
    'native-release.yml',
    'native-build.yml',
    'native-submit.yml',
    'release-components.yml',
    'recover-release.yml',
    'dependency-audit.yml'
  ]) {
    assertReviewedReleaseActionPins(workflowName);
  }
  const credentialedWorkflows = [
    'cut-release.yml',
    'publish-release.yml',
    'container.yml',
    'expo-ota-update.yml',
    'native-release.yml'
  ].map(readWorkflow).join('\n');
  assert.doesNotMatch(
    credentialedWorkflows,
    /echo\s+"Native tag trust set:[^"\r\n]*`/,
    'trust-set summaries must not execute Markdown backticks as Bash command substitutions'
  );
  const ota = readWorkflow('expo-ota-update.yml');
  const publishRelease = readWorkflow('publish-release.yml');
  const cutRelease = readWorkflow('cut-release.yml');
  const easToolPackage = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'tools', 'eas-cli', 'package.json'), 'utf8')
  );
  const easToolLock = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'tools', 'eas-cli', 'package-lock.json'), 'utf8')
  );
  assert.deepEqual(easToolPackage.devDependencies, { 'eas-cli': '22.4.0' });
  assert.deepEqual(easToolPackage.overrides, {
    'minimatch@5.1.2': '5.1.8',
    'nanoid@3.3.8': '3.3.18',
    'tar@7.5.19': '7.5.21'
  });
  assert.equal(easToolLock.lockfileVersion, 3);
  assert.equal(easToolLock.packages[''].devDependencies['eas-cli'], '22.4.0');
  assert.equal(easToolLock.packages['node_modules/eas-cli'].version, '22.4.0');
  assert.equal(easToolLock.packages['node_modules/minimatch'].version, '5.1.8');
  assert.equal(easToolLock.packages['node_modules/nanoid'].version, '3.3.18');
  assert.equal(easToolLock.packages['node_modules/tar'].version, '7.5.21');
  assert.match(easToolLock.packages['node_modules/eas-cli'].integrity, /^sha512-/);
  for (const [packagePath, record] of Object.entries(easToolLock.packages)) {
    if (!packagePath || record.link) continue;
    assert.equal(typeof record.version, 'string', `${packagePath} must resolve an exact version`);
    assert.match(record.integrity, /^sha512-/, `${packagePath} must carry a registry integrity hash`);
  }
  assert.doesNotMatch(ota, /expo\/expo-github-action|eas-version:|\bnpx\b|\byarn\b/);
  assert.equal(
    (ota.match(/npm ci --prefix \.release-tooling\/tools\/eas-cli --include=dev --no-audit --fund=false/g) ?? []).length,
    4
  );
  assert.equal(
    (ota.match(/\.release-tooling\/tools\/eas-cli\/node_modules\/\.bin\/eas/g) ?? []).length,
    2
  );
  const releaseEasSources = [
    readFileSync(path.join(repositoryRoot, 'scripts', 'native-ota-update.mjs'), 'utf8'),
    readFileSync(path.join(repositoryRoot, 'docs', 'mobile-release.md'), 'utf8'),
    ...['expo-ota-update.yml', 'publish-release.yml', 'cut-release.yml', 'native-release.yml']
      .map(readWorkflow)
  ].join('\n');
  assert.doesNotMatch(releaseEasSources, /eas-cli@latest/i);
  assert.doesNotMatch(releaseEasSources, /^\s*npx(?:\.cmd)?\b[^\r\n]*\beas(?:-cli)?\b/gmi);
  const mobileReleaseDocs = readFileSync(
    path.join(repositoryRoot, 'docs', 'native-store-release.md'),
    'utf8'
  );
  const localNativeDocs = readFileSync(path.join(repositoryRoot, 'docs', 'mobile-release.md'), 'utf8');
  assert.match(localNativeDocs, /npm\.cmd run native:setup/);
  assert.match(localNativeDocs, /locked EAS CLI/);
  assert.match(localNativeDocs, /\.\.\\tools\\eas-cli\\node_modules\\\.bin\\eas\.cmd login/);
  assert.match(localNativeDocs, /\.\.\\tools\\eas-cli\\node_modules\\\.bin\\eas\.cmd project:info/);
  assert.doesNotMatch(localNativeDocs, /^\s*eas(?:\.cmd)?\s+(?:login|project:info)\b/gm);
  assert.doesNotMatch(publishRelease, /EXPO_TOKEN|DEPLOY_/);
  assert.doesNotMatch(publishRelease, /publish_ota:[\s\S]*secrets: inherit/);
  assert.doesNotMatch(cutRelease, /uses: \.\/\.github\/workflows\/publish-release\.yml[\s\S]*secrets: inherit/);
  assert.match(mobileReleaseDocs, /GitHub `preview` environment/);
  assert.match(mobileReleaseDocs, /repository `EXPO_TOKEN` secret/);
  assert.match(mobileReleaseDocs, /required reviewer and\n {3}branch policy/);
  assert.match(mobileReleaseDocs, /account\/project scoped, not channel scoped/);
  assert.match(mobileReleaseDocs, /EXPO_TOKEN/);
});

test('server publication accepts read-only master requests through protected default-branch handlers', () => {
  const cases = [
    {
      request: 'cut-release-request.yml',
      handler: 'cut-release-handler.yml',
      staticName: 'Cut release',
      path: '.github/workflows/cut-release-request.yml',
      artifact: 'cut-release-request',
      operation: 'cut-release',
      worker: 'cut-release.yml'
    },
    {
      request: 'publish-release-request.yml',
      handler: 'publish-release-handler.yml',
      staticName: 'Publish prepared release',
      path: '.github/workflows/publish-release-request.yml',
      artifact: 'publish-prepared-release-request',
      operation: 'publish-prepared-release',
      worker: 'publish-release.yml'
    },
    {
      request: 'container-request.yml',
      handler: 'container-handler.yml',
      staticName: 'Build Release Image',
      path: '.github/workflows/container-request.yml',
      artifact: 'build-release-image-request',
      operation: 'build-release-image',
      worker: 'container.yml'
    }
  ];

  for (const entry of cases) {
    const request = readWorkflow(entry.request);
    const handler = readWorkflow(entry.handler);
    const worker = readWorkflow(entry.worker);

    assert.match(request, /\n {2}workflow_dispatch:/);
    assert.doesNotMatch(request, /workflow_run:|workflow_call:|\n\s+push:|\n\s+pull_request:/);
    assert.match(request, /permissions:\s*\n\s+contents: read/);
    assert.doesNotMatch(request, /^\s{0,8}(?:contents|packages|pull-requests|actions): write\s*$/gm);
    assert.doesNotMatch(request, /environment:|secrets\.|secrets: inherit|uses: \.\//);
    assert.doesNotMatch(request, /actions\/checkout|actions\/create-github-app-token|docker\/login-action/);
    assert.match(request, /GITHUB_REF.*refs\/heads\/master/);
    assert.match(request, new RegExp(`--arg operation ${entry.operation}`));
    assert.match(request, new RegExp(`name: ${entry.artifact}`));
    assert.match(request, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(request, /overwrite: true/);

    assert.match(handler, new RegExp(`workflows:\\s*\\n\\s+- ${entry.staticName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(handler, /types:\s*\n\s+- completed[\s\S]*branches:\s*\n\s+- master/);
    assert.match(handler, /permissions:\s*\n\s+actions: read\s*\n\s+contents: read/);
    if (entry.worker === 'cut-release.yml') assert.match(handler, /pull-requests: read/);
    assert.doesNotMatch(workflowJobBlock(handler, 'verify_request'), /^\s{0,8}(?:contents|packages|pull-requests|actions): write\s*$/gm);
    assert.doesNotMatch(handler, /environment:|SERVER_RELEASE_APP_|GHCR_PUBLISH_|secrets: inherit/);
    const handlerFreshness = handler.match(
      /\n {6}- name: Require current protected master handler\n[\s\S]*?(?=\n {6}- name:)/
    )?.[0];
    assert.ok(handlerFreshness);
    assert.match(handlerFreshness, /WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/);
    assert.match(handlerFreshness, /git\/ref\/heads\/master/);
    assert.match(handlerFreshness, /CURRENT_MASTER_SHA.*WORKFLOW_SHA/s);
    assert.ok(
      handler.indexOf('Require current protected master handler') <
        handler.indexOf('release-request.mjs verify') &&
        handler.indexOf('Require current protected master handler') <
          handler.indexOf(`uses: ./.github/workflows/${entry.worker}`)
    );
    assert.match(handler, /release-handler-event\.mjs verify/);
    assert.match(handler, new RegExp(`--workflow-path ${entry.path.replaceAll('.', '\\.')}`));
    assert.match(handler, /--event-file "\$\{GITHUB_EVENT_PATH\}"/);
    assert.match(handler, /--repository "\$\{\{ github\.repository \}\}"/);
    assert.match(handler, /--repository-id "\$\{\{ github\.repository_id \}\}"/);
    assert.match(handler, /--handler-ref "\$\{\{ github\.ref \}\}"/);
    assert.match(handler, /--handler-sha "\$\{\{ job\.workflow_sha \}\}"/);
    assert.doesNotMatch(
      handler,
      /REQUEST_WORKFLOW_NAME|github\.event\.workflow_run\.name/,
      'dynamic run names such as Cut minor release from master must not replace the static trigger authority'
    );
    assert.match(handler, /ref: \$\{\{ job\.workflow_sha \}\}[\s\S]*persist-credentials: false/);
    assert.match(handler, new RegExp(`name: ${entry.artifact}`));
    assert.match(handler, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
    assert.match(handler, /github-token: \$\{\{ github\.token \}\}/);
    assert.match(handler, new RegExp(`--operation ${entry.operation}`));
    assert.match(handler, new RegExp(`uses: \\.\\/\\.github\\/workflows\\/${entry.worker.replace('.', '\\.')}`));

    assert.match(worker, /\n {2}workflow_call:/);
    assert.doesNotMatch(worker, /^ {2}(?:workflow_dispatch|workflow_run):/gm);
  }

  const releaseDocs = readFileSync(path.join(repositoryRoot, 'docs', 'release-compatibility.md'), 'utf8');
  assert.match(releaseDocs, /Allow GitHub Actions to create and approve pull requests/);
  assert.match(releaseDocs, /Manage Actions access/);
  assert.match(releaseDocs, /No new server\npublication environment approvals are required/);
  assert.match(releaseDocs, /production approval remain in force/);
});

test('server publication grants only the operation-specific built-in token permissions', () => {
  const cases = [
    ['cut-release.yml', 'prepare', { contents: 'read' }],
    ['cut-release.yml', 'publish_candidate', { actions: 'read', contents: 'write' }],
    ['cut-release.yml', 'release-validation', { contents: 'read' }],
    ['cut-release.yml', 'finalize', { contents: 'write', 'pull-requests': 'write', actions: 'read', checks: 'write' }],
    ['cut-release.yml', 'inspect_cleanup', { contents: 'read', 'pull-requests': 'read' }],
    ['cut-release.yml', 'cleanup-candidate', { contents: 'write', 'pull-requests': 'write' }],
    ['publish-release.yml', 'tag_release', { contents: 'read' }],
    ['publish-release.yml', 'publish_release_tag', { contents: 'write' }],
    ['publish-release.yml', 'verify_published_release', { contents: 'read' }],
    ['container.yml', 'build_image', { actions: 'read', contents: 'read' }],
    ['container.yml', 'attest_image_receipt', { attestations: 'write', contents: 'read', 'id-token': 'write' }],
    ['container.yml', 'publish_image', { actions: 'read', attestations: 'read', contents: 'read', packages: 'write' }]
  ];
  for (const [workflowName, jobName, expected] of cases) {
    const job = workflowJobBlock(readWorkflow(workflowName), jobName);
    assert.deepEqual(workflowPermissions(job, 4), expected, workflowName + ' ' + jobName);
    assert.doesNotMatch(job, /environment:|SERVER_RELEASE_APP_|GHCR_PUBLISH_|create-github-app-token|server-release-tag-protection/);
  }
  for (const workflowName of ['cut-release-handler.yml', 'publish-release-handler.yml', 'cut-release.yml', 'release-components.yml']) {
    const workflow = readWorkflow(workflowName);
    assert.match(workflow, /EXPO_TOKEN: \$\{\{ secrets\.EXPO_TOKEN \}\}/);
    assert.doesNotMatch(workflow, /secrets: inherit/);
  }
});

test('Cut release uses a read-only request, protected handler, and scoped token writes', () => {
  const request = readWorkflow('cut-release-request.yml');
  const handler = readWorkflow('cut-release-handler.yml');
  const workflow = readWorkflow('cut-release.yml');
  const packageConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const prepare = workflowJobBlock(workflow, 'prepare');
  const publishCandidate = workflowJobBlock(workflow, 'publish_candidate');
  const validation = workflowJobBlock(workflow, 'release-validation');
  const finalize = workflowJobBlock(workflow, 'finalize');
  const inspectCleanup = workflowJobBlock(workflow, 'inspect_cleanup');
  const cleanup = workflowJobBlock(workflow, 'cleanup-candidate');
  const publish = workflowJobBlock(workflow, 'publish');

  assert.match(request, /workflow_dispatch:[\s\S]*bump:[\s\S]*type: choice/);
  assert.match(request, /options:\s*\n\s+- patch\s*\n\s+- minor\s*\n\s+- major/);
  assert.match(request, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(request, /environment:|secrets\.|actions\/checkout|contents: write|packages: write/);
  assert.match(request, /head_sha "\$\{GITHUB_SHA\}"/);
  assert.match(request, /name: cut-release-request[\s\S]*overwrite: true/);

  assert.match(handler, /workflow_run:[\s\S]*workflows:\s*\n\s+- Cut release/);
  assert.match(handler, /permissions:\s*\n\s+actions: read\s*\n\s+contents: read\s*\n\s+pull-requests: read/);
  assert.match(handler, /release-handler-event\.mjs verify/);
  assert.match(handler, /release-request\.mjs verify/);
  assert.match(handler, /source_sha: \$\{\{ steps\.verify\.outputs\.source_sha \}\}/);
  assert.match(handler, /echo "source_sha=\$\{REQUEST_HEAD_SHA\}"/);
  assert.match(handler, /uses: \.\/\.github\/workflows\/cut-release\.yml/);
  assert.match(handler, /source_sha: \$\{\{ needs\.verify_request\.outputs\.source_sha \}\}/);
  assert.doesNotMatch(workflowJobBlock(handler, 'verify_request'), /environment:|secrets\.|contents: write|packages: write|pull-requests: write/);

  assert.match(workflow, /workflow_call:[\s\S]*source_sha:[\s\S]*required: true/);
  assert.doesNotMatch(workflow, /^ {2}(?:workflow_dispatch|workflow_run|push):/gm);
  assert.match(workflow, /group: cut-release/);
  assert.match(workflow, /group: cut-release\s*\n\s+queue: max/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /permissions:\s*\n\s+actions: read\s*\n\s+attestations: write\s*\n\s+contents: write\s*\n\s+id-token: write/);
  assert.doesNotMatch(workflow, /secrets: inherit|SERVER_RELEASE_APP_|create-github-app-token/);
  assert.equal(
    (workflow.match(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/g) ?? []).length,
    10,
    'selection and reservation add two scoped record operations to existing candidate checks'
  );
  for (const [jobName, job, mutation] of [
    ['publish_candidate', publishCandidate, 'Publish only the exact verified candidate branch'],
    ['finalize', finalize, 'Open or reuse the exact release pull request'],
    ['cleanup-candidate', cleanup, 'Find only the exact open candidate pull request']
  ]) {
    const namedSteps = job.split(/\n(?=\s{6}- name:)/);
    const authorityIndex = namedSteps.findIndex((step) => step.includes('Recheck current protected master immediately before repository writes'));
    const mutationIndex = namedSteps.findIndex((step) => step.includes(mutation));
    assert.ok(authorityIndex > 0, jobName + ' must recheck workflow authority');
    assert.equal(mutationIndex, authorityIndex + 1, jobName + ' must recheck live master immediately before mutation');
    assert.match(namedSteps[authorityIndex], /WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}[\s\S]*git\/ref\/heads\/master/);
  }
  assert.match(packageConfig.scripts['release:prepare'], /release-config\.mjs prepare/);

  assert.match(prepare, /permissions:\s*\n\s+contents: read/);
  assert.match(prepare, /Checkout exact protected master source[\s\S]*ref: \$\{\{ inputs\.source_sha \}\}[\s\S]*persist-credentials: false/);
  assert.match(prepare, /SOURCE_SHA.*REQUESTED_SOURCE_SHA.*REMOTE_MASTER_SHA/s);
  assert.match(prepare, /release:prepare -- --bump/);
  assert.match(prepare, /BRANCH="release\/\$\{TAG\}"/);
  assert.match(prepare, /git commit -m "Prepare release \$\{TAG\}"/);
  assert.match(prepare, /git --no-replace-objects bundle create/);
  assert.match(prepare, /Upload exact release candidate bundle[\s\S]*overwrite: true/);
  assert.doesNotMatch(prepare, /create-github-app-token|SERVER_RELEASE_APP_|git[^\n]*push|github\.token/);

  assert.doesNotMatch(publishCandidate, /environment:|secrets./);
  assert.match(publishCandidate, /permissions:\s*\n\s+actions: read\s*\n\s+contents: write/);
  assert.match(publishCandidate, /Download exact release candidate bundle/);
  assert.match(publishCandidate, /Require current protected master workflow[\s\S]*git\/ref\/heads\/master/);
  assert.ok(
    publishCandidate.indexOf('Require current protected master workflow') <
      publishCandidate.indexOf('Recheck current protected master immediately before repository writes')
  );
  assert.match(publishCandidate, /sha256sum --check --strict SHA256SUMS/);
  assert.match(publishCandidate, /verify-prepared-candidate[\s\S]*--candidate-parent-current-master true/);
  assert.ok(
    publishCandidate.indexOf('Verify candidate artifact and canonical transformation before authentication') <
      publishCandidate.indexOf('Publish only the exact verified candidate branch')
  );
  assert.match(publishCandidate, /RELEASE_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    publishCandidate,
    /--force-with-lease="refs\/heads\/\$\{RELEASE_BRANCH\}:"[\s\S]*"\$\{RELEASE_SHA\}:refs\/heads\/\$\{RELEASE_BRANCH\}"/
  );

  assert.match(validation, /needs: \[prepare, publish_candidate\]/);
  assert.match(validation, /permissions:\s*\n\s+contents: read/);
  assert.match(validation, /Checkout exact published candidate[\s\S]*persist-credentials: false/);
  assert.match(validation, /ref: \$\{\{ needs\.prepare\.outputs\.release_sha \}\}/);
  assert.match(validation, /verify-prepared-candidate[\s\S]*--candidate-parent-current-master true/);
  assert.match(validation, /git diff --check "\$\{SOURCE_SHA\}" "\$\{RELEASE_SHA\}"/);
  assert.match(validation, /docker build --file Dockerfile\.app --tag calibrate:release-candidate \./);
  assert.match(validation, /docker run --detach --name calibrate-release-smoke --network host/);
  assert.match(validation, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/readyz/);
  assert.match(validation, /npm run test:container:web -- http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(validation, /create-github-app-token|SERVER_RELEASE_APP_|github\.token/);

  assert.match(finalize, /needs: \[prepare, publish_candidate, release-validation, candidate-lint, candidate-tests, candidate-builds, candidate-container-scan, candidate-database-upgrade\]/);
  assert.doesNotMatch(finalize, /environment:|secrets./);
  assert.match(finalize, /permissions:\s*\n\s+contents: write\s*\n\s+pull-requests: write/);
  assert.match(finalize, /Require current protected master workflow[\s\S]*git\/ref\/heads\/master/);
  assert.ok(
    finalize.indexOf('Require current protected master workflow') <
      finalize.indexOf('Recheck current protected master immediately before repository writes')
  );
  assert.ok(
    finalize.indexOf('Reverify exact branch and candidate before authentication') <
      finalize.indexOf('Open or reuse the exact release pull request')
  );

  assert.match(finalize, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(finalize, /github\.rest\.pulls\.create/);
  assert.doesNotMatch(finalize, /github\.rest\.pulls\.merge/);
  assert.match(finalize, /refs\/pull\/\$\{PULL_REQUEST_NUMBER\}\/merge/);
  assert.match(finalize, /MERGE_SHA\}\^1.*SOURCE_SHA/);
  assert.match(finalize, /MERGE_SHA\}\^2.*RELEASE_SHA/);
  assert.match(finalize, /--request PUT[\s\S]*sha: \$sha, merge_method: "merge"[\s\S]*pulls\/\$\{PULL_REQUEST_NUMBER\}\/merge/);
  assert.match(finalize, /select\(\.merged == true\)/);
  assert.doesNotMatch(finalize, /git[^\n]*push|--force-with-lease/);
  assert.match(finalize, /Verify exact release ancestry[\s\S]*MERGE_SHA\}\^1[\s\S]*SOURCE_SHA[\s\S]*MERGE_SHA\}\^\{tree\}[\s\S]*RELEASE_SHA\}\^\{tree\}/);
  assert.match(finalize, /Verify exact release ancestry[\s\S]*MERGE_SHA\}\^2[\s\S]*RELEASE_SHA/);

  assert.match(inspectCleanup, /always\(\).*needs\.finalize\.result != 'success'/);
  assert.match(inspectCleanup, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(inspectCleanup, /environment:|create-github-app-token|permission-contents: write/);
  assert.doesNotMatch(cleanup, /environment:|secrets./);
  assert.match(cleanup, /permissions:\s*\n\s+contents: write\s*\n\s+pull-requests: write/);
  assert.match(cleanup, /Require current protected master workflow[\s\S]*git\/ref\/heads\/master/);
  assert.ok(
    cleanup.indexOf('Require current protected master workflow') <
      cleanup.indexOf('Recheck current protected master immediately before repository writes')
  );
  assert.ok(
    cleanup.indexOf('Reverify exact cleanup target before authentication') <
      cleanup.indexOf('Find only the exact open candidate pull request')
  );

  assert.match(cleanup, /github\.rest\.pulls\.update/);
  assert.match(cleanup, /REMOTE_SHA.*RELEASE_SHA/);
  assert.match(
    cleanup,
    /--force-with-lease="refs\/heads\/\$\{RELEASE_BRANCH\}:\$\{RELEASE_SHA\}"[\s\S]*":refs\/heads\/\$\{RELEASE_BRANCH\}"/
  );

  assert.match(publish, /uses: \.\/\.github\/workflows\/release-components\.yml/);
  assert.match(
    publish,
    /permissions:\s*\n\s+actions: read\s*\n\s+attestations: write\s*\n\s+contents: write\s*\n\s+id-token: write/
  );
  assert.doesNotMatch(publish, /(?:pull-requests|actions):\s*write/);
  assert.match(publish, /release_commit: \$\{\{ needs\.prepare\.outputs\.release_sha \|\| inputs\.source_sha \}\}/);
  assert.match(publish, /release_branch: \$\{\{ needs\.prepare\.outputs\.release_branch \}\}/);
  assert.doesNotMatch(publish, /secrets: inherit/);
  assert.match(publish, /EXPO_TOKEN: \$\{\{ secrets\.EXPO_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /\n {2}database-rollback:|database_migrations_changed|test:db:rollback/);

  const checkoutCount = (workflow.match(/uses: actions\/checkout@[0-9a-f]{40}/g) ?? []).length;
  assert.ok(checkoutCount > 0);
  assert.equal(
    (workflow.match(/persist-credentials: false/g) ?? []).length,
    checkoutCount,
    'every Cut worker checkout must disable persisted credentials'
  );
});

test('prepared release publishing is reusable, recoverable, and idempotent', () => {
  const workflow = readWorkflow('publish-release.yml');
  const tag = workflowJobBlock(workflow, 'tag_release');
  const publisher = workflowJobBlock(workflow, 'publish_release_tag');
  const publishedVerifier = workflowJobBlock(workflow, 'verify_published_release');
  const image = workflowJobBlock(workflow, 'build_release_image');

  assert.match(workflow, /workflow_call:/);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_commit:/);
  assert.match(workflow, /release_branch:/);
  assert.match(workflow, /group: publish-prepared-release-\$\{\{ inputs\.release_commit \}\}/);
  assert.match(workflow, /group: publish-prepared-release-\$\{\{ inputs\.release_commit \}\}\s*\n\s+queue: max/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\njobs:')), /contents: write|packages: write/);
  assert.match(tag, /permissions:\s*\n\s+contents: read/);
  assert.match(tag, /ref: \$\{\{ inputs\.release_commit \}\}/);
  assert.match(tag, /Checkout exact prepared release[\s\S]*persist-credentials: false/);
  assert.match(tag, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(tag, /path: \.release-tooling/);
  assert.match(tag, /verify-prepared-candidate/);
  assert.match(tag, /Existing tag/);
  assert.doesNotMatch(tag, /contents: write|git push|git tag -a|native_release_ready/);
  assert.doesNotMatch(publisher, /environment:|SERVER_RELEASE_APP_|create-github-app-token|server-release-tag-protection/);
  assert.match(publisher, /permissions:\s*\n\s+contents: write/);
  assert.match(publisher, /needs: tag_release/);
  assert.match(publisher, /Require current protected workflow authority before tag credentials[\s\S]*verify-current-release-workflow/);
  assert.match(publisher, /actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3/);
  assert.match(publisher, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(publisher, /\^v\\d\+\\\.\\d\+\\\.\\d\+\$/);
  assert.match(publisher, /branch !== `release\/\$\{tag\}`/);
  assert.match(publisher, /github\.rest\.git\.createTag/);
  assert.match(publisher, /github\.rest\.git\.createRef/);
  assert.match(publisher, /github\.rest\.git\.getTag/);
  assert.match(publisher, /tagObject\.data\.object\.sha !== commit/);
  assert.doesNotMatch(publisher, /ref: \$\{\{ inputs\.release_commit \}\}|\bnpm\b/);
  assert.doesNotMatch(publisher, /secrets\.GITHUB_TOKEN/);
  const finalAuthorityGateIndex = publisher.indexOf('- name: Recheck current protected workflow immediately before repository writes');
  const tagMutationIndex = publisher.indexOf('- name: Create or verify exact annotated release tag');
  assert.ok(finalAuthorityGateIndex > 0);
  assert.equal(publisher.slice(0, tagMutationIndex).lastIndexOf('- name:'), finalAuthorityGateIndex);
  const finalAuthorityGate = publisher.slice(finalAuthorityGateIndex, tagMutationIndex);
  assert.match(finalAuthorityGate, /verify-current-release-workflow/);
  assert.match(finalAuthorityGate, /--workflow-sha "\$\{WORKFLOW_SHA\}"/);
  assert.match(finalAuthorityGate, /--release-commit "\$\{RELEASE_COMMIT\}"/);
  assert.match(finalAuthorityGate, /GIT_NO_REPLACE_OBJECTS=1/);

  assert.match(publishedVerifier, /needs: \[tag_release, publish_release_tag\]/);
  assert.match(publishedVerifier, /persist-credentials: false/);
  assert.match(
    publishedVerifier,
    /release-config\.mjs verify-prepared[\s\S]*--release-tag "\$\{RELEASE_TAG\}"[\s\S]*--expected-commit "\$\{EXPECTED_COMMIT\}"[\s\S]*--publish-latest true/
  );
  assert.match(image, /uses: \.\/\.github\/workflows\/container\.yml/);
  assert.match(image, /needs: \[tag_release, publish_release_tag, verify_published_release\]/);
  assert.match(image, /permissions:\s*\n\s+actions: read\s*\n\s+attestations: write\s*\n\s+contents: read\s*\n\s+id-token: write/);
  assert.match(image, /packages: write/);
  assert.doesNotMatch(image, /secrets: inherit/);
  assert.match(image, /publish_latest: true/);
  assert.doesNotMatch(workflow, /SERVER_RELEASE_APP_|GHCR_PUBLISH_|server-release-publication/);
  assert.doesNotMatch(workflow, /native_build_ref_override/);
  assert.doesNotMatch(workflow, /pull_request_target|createWorkflowDispatch/);
  assert.doesNotMatch(workflow, /calibratehealth\.app\/api\/v1\/client-config|wait_for_hosted_release/);
});

test('selected deployment gates client publication without changing the deployment worker', () => {
  const graph = parse(readWorkflow('release-components.yml')).jobs;
  assert.equal(graph.deploy.uses, './.github/workflows/deploy-self-hosted.yml');
  assert.match(graph.deployment_intent.if, /outputs.server == 'true'/);
  assert.match(graph.ota.if, /outputs.server != 'true' \|\| needs.record_deploy.result == 'success'/);
  assert.match(graph.ota.if, /outputs.native != 'true' \|\| needs.queue_phone.result == 'success'/);
  assert.equal(graph.ota.needs.includes('finish_native'), false);
  assert.doesNotMatch(readWorkflow('expo-ota-update.yml'), /deploy-server|deploy-self-hosted|DEPLOY_|self-hosted-testing/);
  const image = readWorkflow('container.yml');
  const publishImage = workflowJobBlock(image, 'publish_image');
  assert.match(image, /value: \$\{\{ jobs\.publish_image\.outputs\.image_ref \}\}/);
  assert.match(publishImage, /image_ref: \$\{\{ steps\.publish\.outputs\.image_ref \}\}/);
  assert.match(publishImage, /name: Publish write-once immutable identities and verified latest\n\s+id: publish/);
  const digestOutput = 'echo "image_ref=${GHCR_IMAGE}@${AUTHORITATIVE_DIGEST}" >> "${GITHUB_OUTPUT}"';
  const outputIndex = publishImage.indexOf(digestOutput);
  assert.ok(outputIndex > 0, 'publish the verified registry identity, including recovered images');
  for (const gate of [
    'verify_receipt_attestation "${AUTHORITATIVE_CONFIG_DIGEST}"',
    'ensure_immutable_alias "${RELEASE_IMAGE}" "${AUTHORITATIVE_DIGEST}"',
    'ensure_immutable_alias "${SOURCE_IMAGE}" "${AUTHORITATIVE_DIGEST}"',
    'require_digest "${LATEST_IMAGE}" "${AUTHORITATIVE_DIGEST}"'
  ]) {
    const gateIndex = publishImage.lastIndexOf(gate);
    assert.ok(gateIndex > 0 && gateIndex < outputIndex, gate + ' must complete before exposing the digest');
  }
  assert.doesNotMatch(workflowJobBlock(image, 'build_image'), /image_ref:/);
  assert.doesNotMatch(image, /^ {2}workflow_dispatch:/m);

  const workflow = readWorkflow('deploy-self-hosted.yml');
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /SELF_HOSTED_DEPLOY_ENABLED|image_ref:|release_tag:|\n {4}if:/);
  assert.match(workflow, /GITHUB_REF.*!=.*refs\/heads\/master/);
  assert.match(workflow, /DEPLOY_WG_ENDPOINT: \$\{\{ secrets\.DEPLOY_WG_ENDPOINT \}\}/);
  assert.match(workflow, /DEPLOY_TOKEN: \$\{\{ secrets\.DEPLOY_TOKEN \}\}/);
  assert.match(workflow, /DEPLOY_URL: \$\{\{ vars\.DEPLOY_URL \}\}/);
  assert.match(workflow, /run: node deploy\/scripts\/connect-and-deploy\.mjs/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /environment: self-hosted-testing/);
  assert.match(workflow, /group: self-hosted-testing-deploy\n\s+cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(workflow, /node scripts\/release-config\.mjs verify-current-release-workflow/);
  assert.match(workflow, /if \[\[ -n "\$\{RELEASE_COMMIT\}" \]\]; then\n\s+RELEASE_ARGS=\(--release-commit "\$\{RELEASE_COMMIT\}"\)/);
  assert.match(workflow, /--workflow-sha "\$\{WORKFLOW_SHA\}"[\s\S]*"\$\{RELEASE_ARGS\[@\]\}"/);
  assert.ok(workflow.indexOf('verify-current-release-workflow') < workflow.indexOf('secrets.DEPLOY_'));
  assertReviewedReleaseActionPins('deploy-self-hosted.yml');
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /pull_request:|workflow_run:|packages: write|contents: write/);
  assert.doesNotMatch(workflow, /runs-on:.*self-hosted|continue-on-error|DEPLOY_SSH_|ssh-keyscan/);
  for (const match of workflow.matchAll(/uses: ([^\n]+)/g)) assert.match(match[1], /@[a-f0-9]{40}(?: |$)/);
});

test('deployment environment secrets are forwarded through every reusable release caller', () => {
  const secretNames = ['DEPLOY_WG_ENDPOINT', 'DEPLOY_WG_PRIVATE_KEY', 'DEPLOY_TOKEN'];
  const callees = new Set(['cut-release.yml', 'release-components.yml', 'recover-release.yml', 'deploy-self-hosted.yml']);
  for (const name of callees) {
    const declarations = parse(readWorkflow(name)).on.workflow_call.secrets;
    for (const secret of secretNames) assert.equal(declarations[secret].required, true, name + ': ' + secret);
  }
  for (const file of readdirSync(workflowsDirectory).filter((name) => name.endsWith('.yml'))) {
    const source = readWorkflow(file);
    assert.doesNotMatch(source, /DEPLOY_SSH_/, file + ' must not retain retired deployment credentials');
    const jobs = source.slice(source.indexOf('\njobs:\n'));
    for (const [, job] of jobs.matchAll(/^ {2}([a-z0-9_-]+):$/gm)) {
      const block = workflowJobBlock(source, job);
      const callee = block.match(/^ {4}uses: \.\/\.github\/workflows\/([^\s]+)$/m)?.[1];
      if (!callees.has(callee)) {
        if (file !== 'deploy-self-hosted.yml') assert.doesNotMatch(block, /DEPLOY_/);
        continue;
      }
      for (const secret of secretNames) {
        assert.ok(block.includes('      ' + secret + ': ${{ secrets.' + secret + ' }}'), file + '/' + job + ': ' + secret);
      }
      assert.doesNotMatch(block, /secrets: inherit/);
    }
  }
});

test('pull requests build and smoke only Web-impacting changes while exhaustive suites stay manual', () => {
  const workflow = readWorkflow('builds.yml');
  const changes = workflowJobBlock(workflow, 'changes');
  const webPaths = workflowPathFilterBlock(changes, 'web');
  const expoWebBuild = workflowJobBlock(workflow, 'expo-web-build');
  const smoke = workflowJobBlock(workflow, 'web-critical-smoke');
  const exportedWeb = workflowJobBlock(workflow, 'exported-web-e2e');
  const dataStates = workflowJobBlock(workflow, 'data-state-acceptance');
  const ux = workflowJobBlock(workflow, 'ux-regression');
  const playwrightConfig = readFileSync(
    path.join(repositoryRoot, 'playwright.expo-web.config.ts'),
    'utf8'
  );
  const packageConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assertPathFilterOutputs(
    changes,
    [
      'release_config',
      'backend',
      'web',
      'wear',
      'native_runtime',
      'native_package',
      'web_release',
      'native_release',
      'native_upgrade'
    ],
    'decision',
    '0e4a8c6effa4802afeda77dc8d303f8176d7dfad'
  );
  const releaseConfig = workflowJobBlock(workflow, 'release-config');

  assert.match(workflow, /on:[\s\S]*?\n {2}pull_request:/);
  assert.match(workflow, /workflow_dispatch:[\s\S]*validation_scope:[\s\S]*configuration-only/);
  assert.match(changes, /if: inputs\.release_sha == '' && github\.event_name == 'pull_request'/);
  assert.doesNotMatch(webPaths, /- 'backend\/\*\*'/);
  assert.doesNotMatch(webPaths, /- 'mobile\/test\/\*\*'/);
  assert.match(webPaths, /- 'mobile\/src\/\*\*'/);
  assert.match(webPaths, /- 'e2e\/expo-web\/release-smoke\.spec\.ts'/);
  assert.doesNotMatch(webPaths, /- 'e2e\/expo-web\/\*\*'/);
  assert.doesNotMatch(webPaths, /performance-budgets/);
  assert.match(webPaths, /- 'scripts\/expo-cli-environment\.mjs'/);
  assert.match(webPaths, /- 'scripts\/expo-web-playwright\.mjs'/);
  assert.match(webPaths, /- 'playwright\.expo-web\.config\.ts'/);
  assert.doesNotMatch(expoWebBuild, /test:performance:web|CALIBRATE_RUN_HOSTED_WEB_VITALS/);
  assert.match(expoWebBuild, /if: needs\.changes\.outputs\.web == 'true'/);
  assert.match(expoWebBuild, /npm\.cmd run build:expo-web/);
  assert.match(smoke, /if: needs\.changes\.outputs\.web == 'true'/);
  assert.match(smoke, /runs-on: windows-latest/);
  assert.match(smoke, /node-version: 24\.14\.0/);
  assert.match(smoke, /node node_modules\/@playwright\/test\/cli\.js install chromium/);
  assert.match(smoke, /npm\.cmd run test:expo-web:smoke/);
  assert.match(playwrightConfig, /if \(process\.env\.CI\) return \{\};[\s\S]*channel:/);
  assert.match(playwrightConfig, /process\.env\.CI \? \[\/launch-21-performance-budgets\\\.spec\\\.ts\/\] : \[\]/);
  assert.equal(
    packageConfig.scripts['test:performance:web'],
    'playwright test --config=playwright.expo-web.config.ts --project=desktop-chrome e2e/expo-web/launch-21-performance-budgets.spec.ts'
  );
  assert.match(packageConfig.scripts['test:expo-web:smoke'], /release-smoke\.spec\.ts/);
  for (const [job, command] of [
    [exportedWeb, 'test:expo-web'],
    [dataStates, 'test:data-states'],
    [ux, 'test:ux']
  ]) {
    assert.match(job, /needs: changes/);
    assert.match(
      job,
      /if: github\.event_name == 'workflow_dispatch' && needs\.changes\.outputs\.web_release == 'true'/
    );
    assert.ok(job.includes(`npm.cmd run ${command}`));
    assert.doesNotMatch(job, /hosted-result/);
  }
  assert.match(ux, /retention-days: 7/);
  assert.match(releaseConfig, /if: needs\.changes\.outputs\.release_config == 'true'/);
  assert.match(
    releaseConfig,
    /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\.4\.0[\s\S]*persist-credentials: false/
  );
  assert.match(
    releaseConfig,
    /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\.4\.0/
  );
});

test('pull requests run backend builds only for backend-impacting paths', () => {
  const workflow = readWorkflow('builds.yml');
  const changes = workflowJobBlock(workflow, 'changes');
  const backendPaths = workflowPathFilterBlock(changes, 'backend');
  const backendBuild = workflowJobBlock(workflow, 'backend-build');

  assert.match(backendPaths, /- 'backend\/\*\*'/);
  assert.match(backendPaths, /- 'shared\/\*\*'/);
  assert.doesNotMatch(backendPaths, /- '!/);
  assert.equal(pathFilterMatches(changes, 'backend', 'package.json'), false);
  assert.equal(pathFilterMatches(changes, 'backend', 'backend/scripts/performance-regression.js'), true);
  assert.match(backendBuild, /needs: changes/);
  assert.match(backendBuild, /if: needs\.changes\.outputs\.backend == 'true'/);
  assert.match(backendBuild, /npm run build/);
  assert.doesNotMatch(workflow, /\n {2}performance-regression:/);
});

test('Android SDK setup explicitly excludes the retired tools package', () => {
  let setupCount = 0;
  for (const file of readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/.test(name))) {
    for (const step of readWorkflow(file).split(/\n(?= {6}- )/)) {
      if (!/uses: android-actions\/setup-android@/.test(step)) continue;
      setupCount += 1;
      assert.match(step, /^ {10}packages: platform-tools$/m,
        `${file} must override setup-android's obsolete default tools package`);
    }
  }
  assert.ok(setupCount > 0, 'Android SDK setup steps must be covered');
});

test('pull requests run targeted native compilation while emulator and upgrade rehearsals stay manual', () => {
  const workflow = readWorkflow('builds.yml');
  const packageConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const changes = workflowJobBlock(workflow, 'changes');
  const runtime = workflowJobBlock(workflow, 'native-metro-bundle');
  const mobileBuild = workflowJobBlock(workflow, 'mobile-build');
  const iosBuild = workflowJobBlock(workflow, 'ios-build');
  const wearBuild = workflowJobBlock(workflow, 'wear-build');
  const android = workflowJobBlock(workflow, 'android-emulator-e2e');
  const wear = workflowJobBlock(workflow, 'wear-release-emulator-smoke');
  const upgrade = workflowJobBlock(workflow, 'native-package-upgrade');

  assert.match(packageConfig.scripts['test:native-release'], /hosted-native-emulators\.test\.mjs/);
  assert.match(packageConfig.scripts['test:native-release'], /hosted-android-e2e\.test\.mjs/);
  assert.match(packageConfig.scripts['test:native-release'], /native-upgrade-rehearsal\.test\.mjs/);
  assert.match(packageConfig.scripts['test:native-release'], /native-tag-attestation\.test\.mjs/);
  assert.match(packageConfig.scripts['test:native-release'], /release-artifact-store\.test\.mjs/);
  assert.equal(
    packageConfig.scripts['test:mobile-build-tools'],
    'node --test scripts/xcode-uuid-compatibility.test.mjs'
  );

  assert.match(workflow, /validation_scope:[\s\S]*- web[\s\S]*- native[\s\S]*- web-and-native[\s\S]*- configuration-only/);
  assert.match(workflow, /run_native_upgrade:[\s\S]*type: boolean/);
  assert.match(workflow, /native_upgrade_baseline:[\s\S]*required: false/);
  assert.match(
    changes,
    /Validate manual native upgrade baseline[\s\S]*if: github\.event_name == 'workflow_dispatch' && inputs\.run_native_upgrade[\s\S]*\^\[0-9a-f\]\{40\}\$/
  );

  const wearPaths = workflowPathFilterPaths(changes, 'wear');
  assert.deepEqual(wearPaths, ['wear/**']);

  const nativeRuntimePaths = workflowPathFilterBlock(changes, 'native_runtime');
  for (const expectedPath of [
    'mobile/app/**',
    'mobile/assets/**',
    'mobile/src/**',
    'mobile/app.config.js',
    'mobile/app.json',
    'mobile/babel.config.js',
    'mobile/index.js',
    'mobile/metro.config.js',
    'mobile/modules/**',
    'mobile/package.json',
    'package-lock.json',
    'packages/api-client/**',
    'scripts/xcode-uuid-compatibility.test.mjs',
    'shared/**'
  ]) {
    assert.ok(nativeRuntimePaths.includes(`- '${expectedPath}'`), `native_runtime must include ${expectedPath}`);
  }
  assert.doesNotMatch(nativeRuntimePaths, /- 'package\.json'/);
  assert.doesNotMatch(nativeRuntimePaths, /\.github\/workflows\/builds\.yml/);

  const nativePackagePaths = workflowPathFilterBlock(changes, 'native_package');
  for (const expectedPath of [
    'mobile/app.config.js',
    'mobile/app.json',
    'mobile/eas.json',
    'mobile/assets/**',
    'mobile/modules/**',
    'mobile/package.json',
    'mobile/plugins/**',
    'package-lock.json'
  ]) {
    assert.ok(nativePackagePaths.includes(`- '${expectedPath}'`), `native_package must include ${expectedPath}`);
  }
  assert.doesNotMatch(nativePackagePaths, /mobile\/src|- 'package\.json'|scripts\/|\.github\/workflows/);

  assert.match(
    runtime,
    /if: needs\.changes\.outputs\.native_runtime == 'true' \|\| needs\.changes\.outputs\.native_package == 'true'/
  );
  assert.match(runtime, /npm run test:mobile-build-tools/);
  assert.match(runtime, /platform: \[android, ios\]/);
  assert.match(
    runtime,
    /node \.\.\/node_modules\/expo\/bin\/cli export --platform "\$\{\{ matrix\.platform \}\}" --output-dir "\$\{RUNNER_TEMP\}\/calibrate-\$\{\{ matrix\.platform \}\}-export"/
  );
  assert.match(mobileBuild, /if: needs\.changes\.outputs\.native_package == 'true'/);
  assert.match(mobileBuild, /Build Android debug/);
  assert.match(iosBuild, /if: needs\.changes\.outputs\.native_package == 'true'/);
  assert.match(iosBuild, /runs-on: macos-latest/);
  assert.match(iosBuild, /npm ci --include=dev --no-audit --fund=false/);
  assert.match(iosBuild, /npm --prefix mobile run prebuild:ios/);
  assert.match(iosBuild, /pod install/);
  const { expo } = JSON.parse(readFileSync(path.join(repositoryRoot, 'mobile/app.json'), 'utf8'));
  assert.equal(iosBuild.match(/-workspace (\S+)/)?.[1], `${expo.name}.xcworkspace`);
  assert.equal(iosBuild.match(/-scheme (\S+)/)?.[1], expo.name,
    'Xcode scheme names must match the case of the Expo-generated project');
  assert.match(iosBuild, /xcodebuild[\s\S]*generic\/platform=iOS Simulator[\s\S]*CODE_SIGNING_ALLOWED=NO/);
  assert.match(wearBuild, /if: needs\.changes\.outputs\.wear == 'true'/);
  assert.match(wearBuild, /assembleDebug testDebugUnitTest/);

  assert.match(mobileBuild, /if: needs\.changes\.outputs\.native_release == 'true'[\s\S]*actions\/upload-artifact@v4/);
  for (const [job, outputName] of [
    [android, 'native_release'],
    [wear, 'native_release'],
    [upgrade, 'native_upgrade']
  ]) {
    assert.match(
      job,
      new RegExp(`if: github\\.event_name == 'workflow_dispatch' && needs\\.changes\\.outputs\\.${outputName} == 'true'`)
    );
    assert.match(job, /retention-days: 7/);
    assert.doesNotMatch(job, /release-acceptance\.mjs hosted-result|retention-days: 90|test:risk-evidence:release/);
  }

  assert.match(android, /needs: \[changes, mobile-build\]/);
  assert.match(android, /script: node scripts\/hosted-android-e2e\.mjs/);
  assert.match(wear, /target: android-wear/);
  assert.match(wear, /profile: wearos_large_round/);
  assert.match(wear, /npm run test:wear:emulator/);
  assert.match(upgrade, /--baseline "\$NATIVE_UPGRADE_BASELINE"/);
  assert.match(upgrade, /--candidate "\$CALIBRATE_SOURCE_COMMIT"/);
  assert.match(upgrade, /--phone-serial emulator-5554/);
  assert.match(upgrade, /--wear-serial emulator-5556/);
  assert.match(upgrade, /--execute --package-only/);
  assert.throws(() => workflowJobBlock(workflow, 'android.*'), /literal safe identifier/);
});

test('native jobs bind immutable candidate and baseline SHAs for PR and manual events', () => {
  const workflow = readWorkflow('builds.yml');
  const mobileBuild = workflowJobBlock(workflow, 'mobile-build');
  const android = workflowJobBlock(workflow, 'android-emulator-e2e');
  const wear = workflowJobBlock(workflow, 'wear-release-emulator-smoke');
  const upgrade = workflowJobBlock(workflow, 'native-package-upgrade');
  const candidateExpression = '${{ github.event.pull_request.head.sha || github.sha }}';

  assert.ok(mobileBuild.includes(`name: android-debug-apk-${candidateExpression}`));
  assert.ok(android.includes(`name: android-debug-apk-${candidateExpression}`));
  for (const job of [android, wear, upgrade]) {
    assert.ok(job.includes(`CALIBRATE_SOURCE_COMMIT: ${candidateExpression}`));
  }
  assert.ok(
    upgrade.includes(
      'NATIVE_UPGRADE_BASELINE: ${{ github.event.pull_request.base.sha || inputs.native_upgrade_baseline }}'
    )
  );

  for (const scenario of [
    {
      eventName: 'pull_request',
      pullRequestHeadSha: '1'.repeat(40),
      pullRequestBaseSha: '2'.repeat(40),
      githubSha: '3'.repeat(40),
      manualBaseline: '',
      expectedCandidate: '1'.repeat(40),
      expectedBaseline: '2'.repeat(40)
    },
    {
      eventName: 'workflow_dispatch',
      pullRequestHeadSha: '',
      pullRequestBaseSha: '',
      githubSha: '4'.repeat(40),
      manualBaseline: '5'.repeat(40),
      expectedCandidate: '4'.repeat(40),
      expectedBaseline: '5'.repeat(40)
    }
  ]) {
    const candidate = scenario.pullRequestHeadSha || scenario.githubSha;
    const baseline = scenario.pullRequestBaseSha || scenario.manualBaseline;
    assert.equal(candidate, scenario.expectedCandidate, `${scenario.eventName} candidate`);
    assert.equal(baseline, scenario.expectedBaseline, `${scenario.eventName} baseline`);
    assert.match(candidate, /^[0-9a-f]{40}$/);
    assert.match(baseline, /^[0-9a-f]{40}$/);
  }
});

test('build input classification covers representative paths without cross-surface noise', () => {
  const changes = workflowJobBlock(readWorkflow('builds.yml'), 'changes');
  const filters = ['release_config', 'backend', 'web', 'wear', 'native_runtime', 'native_package'];
  assert.doesNotMatch(workflowPathFilterBlock(changes, 'release_config'), /- '!/);
  assert.doesNotMatch(workflowPathFilterBlock(changes, 'backend'), /- '!/);
  const cases = [
    ['docs/review-notes.md', []],
    ['.github/native-release-tag-allowed-signers', ['release_config']],
    ['.github/native-play-attestation-trusted-workflow-shas', ['release_config']],
    ['.github/release-image-attestation-trusted-workflow-shas', ['release_config']],
    ['tools/eas-cli/package-lock.json', ['release_config']],
    ['.github/workflows/tests.yml', ['release_config']],
    ['.github/workflows/builds.yml', ['release_config']],
    ['backend/src/routes/user.ts', ['backend']],
    ['shared/caloriePolicy.ts', ['backend', 'web', 'native_runtime']],
    ['mobile/src/components/AppCard.tsx', ['web', 'native_runtime']],
    ['mobile/test/jest.setup.ts', []],
    ['mobile/plugins/withHealthConnect.js', ['native_package']],
    ['mobile/assets/icon-ios.png', ['web', 'native_runtime', 'native_package']],
    ['mobile/babel.config.js', ['web', 'native_runtime']],
    ['wear/app/src/main/AndroidManifest.xml', ['release_config', 'wear']],
    ['quality/performance-budgets.json', ['release_config']],
    ['quality/risk-evidence.json', ['release_config']],
    ['scripts/expo-cli-environment.mjs', ['release_config', 'web']],
    ['scripts/expo-web-playwright.mjs', ['release_config', 'web']],
    ['scripts/performance-budgets.mjs', ['release_config']],
    ['scripts/verify-risk-evidence.mjs', ['release_config']],
    ['scripts/release-acceptance.mjs', ['release_config']],
    ['playwright.ux.config.ts', ['release_config']],
    ['scripts/xcode-uuid-compatibility.test.mjs', ['release_config', 'native_runtime']],
    ['e2e/expo-web/release-smoke.spec.ts', ['web']],
    ['e2e/expo-web/launch-21-performance-budgets.spec.ts', []],
    ['package.json', ['release_config', 'web']],
    ['package-lock.json', ['release_config', 'web', 'native_runtime', 'native_package']]
  ];

  for (const [candidatePath, expectedFilters] of cases) {
    const actualFilters = filters.filter((filterName) => pathFilterMatches(changes, filterName, candidatePath));
    assert.deepEqual(actualFilters, expectedFilters, candidatePath);
  }
});

test('manual Wear emulator runs persistence instrumentation after its release-package smoke', () => {
  const wear = workflowJobBlock(readWorkflow('builds.yml'), 'wear-release-emulator-smoke');
  const emulatorStep = wear
    .split(/\n(?=\s+- name:)/)
    .find((step) => step.includes('uses: reactivecircus/android-emulator-runner@v2'));
  assert.ok(emulatorStep, 'Wear job must run on its disposable emulator');

  assert.match(wear, /-keystore mobile\/android\/app\/debug\.keystore/);
  assert.match(wear, /-alias androiddebugkey/);
  assert.match(emulatorStep, /script: \|/);
  assert.match(emulatorStep, /npm run test:wear:emulator/);
  assert.match(emulatorStep, /adb -s "\$WEAR_ADB_SERIAL" uninstall net\.darkmachines\.healthtracker/);
  assert.match(emulatorStep, /:app:connectedDebugAndroidTest/);
  assert.match(emulatorStep, /-PcalibrateWearServerUrl=https:\/\/calibratehealth\.app/);
  assert.match(emulatorStep, /-PcalibrateWearDebugServerUrl=http:\/\/10\.0\.2\.2:3000/);
  assert.doesNotMatch(
    emulatorStep,
    /(^|\s)\\(?=\s|$)/,
    'Wear emulator commands must not pass standalone shell-continuation arguments',
  );

  const releaseSmokeIndex = emulatorStep.indexOf('npm run test:wear:emulator');
  const uninstallIndex = emulatorStep.indexOf('uninstall net.darkmachines.healthtracker');
  const instrumentationIndex = emulatorStep.indexOf(':app:connectedDebugAndroidTest');
  assert.ok(releaseSmokeIndex >= 0, 'Wear release-package smoke must run');
  assert.ok(
    releaseSmokeIndex < uninstallIndex && uninstallIndex < instrumentationIndex,
    'the differently signed release package must be removed before debug instrumentation',
  );
});

test('release images publish immutable identity and guard the moving latest tag', () => {
  const workflow = readWorkflow('container.yml');
  const build = workflowJobBlock(workflow, 'build_image');
  const attester = workflowJobBlock(workflow, 'attest_image_receipt');
  const publisher = workflowJobBlock(workflow, 'publish_image');
  const deployEnvironment = readFileSync(path.join(repositoryRoot, 'deploy', '.env.example'), 'utf8');
  const ghcrPolicy = readFileSync(path.join(repositoryRoot, 'scripts', 'ghcr-release-policy.mjs'), 'utf8');
  const ghcrReceipt = readFileSync(path.join(repositoryRoot, 'scripts', 'ghcr-release-receipt.mjs'), 'utf8');
  const releaseCompatibility = readFileSync(
    path.join(repositoryRoot, 'docs', 'release-compatibility.md'),
    'utf8'
  );
  const agentGuide = readFileSync(path.join(repositoryRoot, 'AGENTS.md'), 'utf8');
  const packageConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));

  assert.match(workflow, /workflow_call:/);
  assert.doesNotMatch(workflow, /^ {2}(?:workflow_dispatch|push):/gm);
  assert.match(workflow, /release_tag:/);
  assert.match(workflow, /release_commit:/);
  assert.match(workflow, /publish_latest:/);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /group: release-image-publication[\s\S]*queue: max[\s\S]*cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /group: release-image-\$\{\{/);
  assert.doesNotMatch(workflow, /^\s{0,8}(?:contents|pull-requests|actions): write\s*$/gm);

  assert.match(build, /Checkout exact prepared release source[\s\S]*ref: \$\{\{ inputs\.release_commit \}\}[\s\S]*persist-credentials: false/);
  assert.match(build, /Checkout reviewed release tooling[\s\S]*ref: \$\{\{ job\.workflow_sha \}\}[\s\S]*persist-credentials: false/);
  assert.match(
    build,
    /release-config\.mjs verify-prepared[\s\S]*--release-tag "\$\{RELEASE_TAG\}"[\s\S]*--expected-commit "\$\{EXPECTED_COMMIT\}"[\s\S]*--publish-latest "\$\{PUBLISH_LATEST\}"/
  );
  assert.match(build, /BUILDX_URL: https:\/\/github\.com\/docker\/buildx\/releases\/download\/v0\.36\.1\/buildx-v0\.36\.1\.linux-amd64/);
  assert.match(build, /BUILDX_SHA256: 48af8a397ebd60178778bf63611dbcebe5f5e7a9be90eb9147b24b9587455778/);
  const buildxSetup = build.match(/- name: Set up digest-pinned BuildKit[\s\S]*?(?=\n\s+- name:)/)?.[0];
  assert.ok(buildxSetup);
  assert.match(buildxSetup, /image=moby\/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8/);
  assert.doesNotMatch(buildxSetup, /github-token:|\n\s+version:/);
  const imageBuild = build.match(/- name: Build AMD64 image without publication credentials[\s\S]*?(?=\n\s+- name:)/)?.[0];
  assert.ok(imageBuild);
  assert.match(imageBuild, /platforms: linux\/amd64/);
  assert.match(imageBuild, /push: false/);
  assert.match(imageBuild, /github-token: ''/);
  assert.doesNotMatch(build, /environment:|docker\/login-action|GHCR_PUBLISH|secrets\.|packages: write/);
  assert.match(build, /docker save --output .*release-image\.tar/);
  for (const field of [
    'repository', 'release_commit', 'release_tag', 'publish_latest', 'ghcr_image',
    'local_image', 'image_id', 'tag_object'
  ]) {
    assert.match(build, new RegExp(`${field}:`));
  }
  assert.match(
    build,
    /ghcr-release-receipt\.mjs create[\s\S]*--repository "\$\{GITHUB_REPOSITORY\}"[\s\S]*--ghcr-image "\$\{GHCR_IMAGE\}"[\s\S]*--release-tag "\$\{RELEASE_TAG\}"[\s\S]*--release-commit "\$\{RELEASE_COMMIT\}"[\s\S]*--image-config-digest "\$\{IMAGE_ID\}"/
  );
  assert.match(build, /release-image-receipt\.json[\s\S]*RECEIPT_SHA256/);
  assert.match(build, /name: verified-release-image[\s\S]*overwrite: true/);

  assert.match(attester, /needs: build_image/);
  assert.match(attester, /permissions:\s*\n\s+attestations: write\s*\n\s+contents: read\s*\n\s+id-token: write/);
  assert.doesNotMatch(attester, /environment:|packages:|GHCR_PUBLISH|SERVER_RELEASE|secrets\.|Checkout exact prepared|Dockerfile|docker load/);
  const attesterSteps = attester.split(/\n(?=\s{6}- name:)/);
  assert.match(attesterSteps[1], /Require current protected workflow authority before receipt construction/);
  assert.match(
    attesterSteps[1],
    /release-config\.mjs" verify-current-release-workflow[\s\S]*--workflow-sha "\$\{WORKFLOW_SHA\}"[\s\S]*--release-commit "\$\{RELEASE_COMMIT\}"/
  );
  assert.match(attesterSteps.at(-2), /Recheck current protected workflow authority immediately before attestation/);
  assert.match(attesterSteps.at(-2), /verify-current-release-workflow/);
  assert.match(attesterSteps.at(-1), /actions\/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d # v4\.2\.1/);
  assert.match(attesterSteps.at(-1), /subject-path: \$\{\{ runner\.temp \}\}\/release-image-receipt\.json/);
  assert.match(attesterSteps.at(-1), /push-to-registry: false[\s\S]*create-storage-record: false/);
  assert.match(attester, /IMAGE_CONFIG_DIGEST: \$\{\{ needs\.build_image\.outputs\.image_id \}\}/);
  assert.match(attester, /EXPECTED_RECEIPT_SHA256: \$\{\{ needs\.build_image\.outputs\.receipt_sha256 \}\}/);

  assert.match(publisher, /needs: \[build_image, attest_image_receipt\]/);
  assert.doesNotMatch(publisher, /environment:|GHCR_PUBLISH_|SERVER_RELEASE_APP_/);
  assert.match(
    publisher,
    /permissions:\s*\n\s+actions: read\s*\n\s+attestations: read\s*\n\s+contents: read/
  );
  assert.doesNotMatch(publisher, /attestations: write|id-token: write/);
  assert.match(publisher, /Download verified image bundle[\s\S]*name: verified-release-image/);
  assert.match(publisher, /Downloaded image artifact must contain exactly the four expected regular files/);
  assert.match(publisher, /EXPECTED_TAR_SHA256[\s\S]*EXPECTED_RECEIPT_SHA256/);
  assert.match(publisher, /sha256sum --check --strict SHA256SUMS/);
  assert.match(publisher, /jq --exit-status[\s\S]*schema_version[\s\S]*tag_object/);
  assert.match(publisher, /docker load --input/);
  assert.match(publisher, /Checkout reviewed release tooling only[\s\S]*ref: \$\{\{ job\.workflow_sha \}\}[\s\S]*persist-credentials: false/);
  assert.doesNotMatch(publisher, /Checkout exact prepared release source|path: \.release-source|Dockerfile\.app|docker\/build-push-action|npm ci|node scripts\//);
  const stepsIndex = publisher.indexOf('\n    steps:');
  const downloadIndex = publisher.indexOf('- name: Download verified image bundle');
  const loadIndex = publisher.indexOf('- name: Load verified image without registry credentials');
  const toolingIndex = publisher.indexOf('- name: Checkout reviewed release tooling only');
  const buildxIndex = publisher.indexOf('- name: Install checksum-verified Buildx CLI plugin before authentication');
  const ghCliIndex = publisher.indexOf('- name: Install checksum-verified GitHub CLI attestation verifier');
  const receiptAttestationIndex = publisher.indexOf(
    '- name: Verify exact built image receipt attestation before registry authentication'
  );
  const finalFreshnessIndex = publisher.indexOf(
    '- name: Recheck current protected workflow authority immediately before GHCR authentication'
  );
  const freshnessIndex = publisher.indexOf(
    '- name: Require current protected workflow authority before image artifact access'
  );
  const loginIndex = publisher.indexOf('- name: Login with the repository package token');
  const publishIndex = publisher.indexOf('- name: Publish write-once immutable identities and verified latest');
  assert.ok(
    0 <= stepsIndex &&
      stepsIndex < freshnessIndex &&
      freshnessIndex < downloadIndex &&
      downloadIndex < loadIndex &&
      loadIndex < toolingIndex &&
      toolingIndex < buildxIndex &&
      buildxIndex < ghCliIndex &&
      ghCliIndex < receiptAttestationIndex &&
      receiptAttestationIndex < finalFreshnessIndex &&
      finalFreshnessIndex < loginIndex &&
      loginIndex < publishIndex
  );
  assert.equal(
    publisher.indexOf('- name:', stepsIndex),
    freshnessIndex,
    'the current-master gate must be the protected publisher job\'s first step'
  );
  assert.doesNotMatch(
    publisher.slice(stepsIndex, freshnessIndex),
    /uses:|download-artifact|docker load|\.release-tooling|vars\.|secrets\.|docker\/login-action/,
    'no artifact, action, tooling, variable, secret, or login may precede the authority gate'
  );
  assert.doesNotMatch(publisher, /server-release-tag-protection/);
  const freshness = publisher.match(
    /\n {6}- name: Require current protected workflow authority before image artifact access\n[\s\S]*?(?=\n {6}- name:)/
  )?.[0];
  assert.ok(freshness, 'publisher must define a current protected workflow authority gate');
  assert.match(freshness, /WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(freshness, /RELEASE_COMMIT: \$\{\{ inputs\.release_commit \}\}/);
  assert.match(freshness, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  assert.match(freshness, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(freshness, /GIT_NO_REPLACE_OBJECTS=1/);
  assert.match(freshness, /GITHUB_REF.*refs\/heads\/master/);
  assert.match(
    freshness,
    /git init --quiet --template='' "\$\{VERIFY_ROOT\}"[\s\S]*remote add origin "https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\.git"[\s\S]*fetch --force --no-tags origin \\\n\s+'\+refs\/heads\/master:refs\/remotes\/origin\/master'/
  );
  assert.match(
    freshness,
    /"\$\{WORKFLOW_SHA\}:scripts\/release-config\.mjs" > "\$\{TOOL_ROOT\}\/scripts\/release-config\.mjs"/
  );
  assert.match(
    freshness,
    /"\$\{WORKFLOW_SHA\}:scripts\/native-tag-attestation\.mjs" > "\$\{TOOL_ROOT\}\/scripts\/native-tag-attestation\.mjs"/
  );
  assert.match(
    freshness,
    /release-config\.mjs" verify-current-release-workflow[\s\S]*--repository-root "\$\{VERIFY_ROOT\}"[\s\S]*--workflow-sha "\$\{WORKFLOW_SHA\}"[\s\S]*--release-commit "\$\{RELEASE_COMMIT\}"/
  );
  assert.equal((freshness.match(/\bfetch\b/g) ?? []).length, 1);
  assert.doesNotMatch(
    freshness,
    /verify-prepared|merge-base --is-ancestor|uses:|download-artifact|docker load|vars\.|secrets\.|docker\/login-action/,
    'the first-step gate must delegate the exact Cut exception without exposing later authority'
  );
  assert.match(publisher, /username: \$\{\{ github\.actor \}\}/);
  assert.match(publisher, /password: \$\{\{ github\.token \}\}/);
  assert.match(publisher, /packages: write/);
  assert.equal([...publisher.matchAll(/\$\{\{ github\.token \}\}/g)].length, 3);
  const finalFreshness = publisher.match(
    /\n {6}- name: Recheck current protected workflow authority immediately before GHCR authentication\n[\s\S]*?(?=\n {6}- name:)/
  )?.[0];
  assert.ok(finalFreshness);
  assert.match(finalFreshness, /verify-current-release-workflow/);
  assert.equal(
    publisher.slice(finalFreshnessIndex).indexOf('- name: Login with the repository package token'),
    publisher.slice(finalFreshnessIndex).indexOf('- name:', 1),
    'the live workflow recheck must be immediately adjacent to GHCR secret materialization'
  );
  assert.match(publisher, /GH_CLI_URL: https:\/\/github\.com\/cli\/cli\/releases\/download\/v2\.97\.0\/gh_2\.97\.0_linux_amd64\.tar\.gz/);
  assert.match(publisher, /GH_CLI_SHA256: a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112/);
  assert.doesNotMatch(publisher, /\bgh attestation verify|\$\{?\s*which gh|GH_CLI_URL:.*latest/);

  assert.match(publisher, /release-config\.mjs verify-prepared[\s\S]*--expected-commit "\$\{RELEASE_COMMIT\}"/);
  assert.match(publisher, /ls-remote[\s\S]*refs\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(publisher, /ghcr-release-policy\.mjs classify-absence/);
  assert.match(publisher, /classify-absence[\s\S]*--error-file "\$\{error_file\}"[\s\S]*--image-ref "\$\{image_ref\}"/);
  assert.match(publisher, /ghcr-release-policy\.mjs validate-manifest/);
  assert.match(
    publisher,
    /config_digest="\$\(node \.release-tooling\/scripts\/ghcr-release-policy\.mjs validate-manifest[\s\S]*--image-config-file "\$\{config_file\}"\)"[\s\S]*printf '%s' "\$\{digest\}"/
  );
  assert.doesNotMatch(publisher, /grep[^\n]*(?:not found|manifest unknown)/i);
  assert.match(publisher, /Immutable image tags disagree/);
  assert.match(publisher, /AUTHORITATIVE_DIGEST="\$\{RELEASE_DIGEST:-\$\{SOURCE_DIGEST\}\}"/);
  assert.match(publisher, /ensure_immutable_alias "\$\{RELEASE_IMAGE\}" "\$\{AUTHORITATIVE_DIGEST\}"/);
  assert.match(publisher, /ensure_immutable_alias "\$\{SOURCE_IMAGE\}" "\$\{AUTHORITATIVE_DIGEST\}"/);
  assert.match(
    publisher,
    /PUBLISHED_FRESH=false[\s\S]*if \[\[ -z "\$\{RELEASE_DIGEST\}" && -z "\$\{SOURCE_DIGEST\}" \]\][\s\S]*docker push "\$\{RELEASE_IMAGE\}"[\s\S]*PUBLISHED_FRESH=true/
  );
  assert.match(
    publisher,
    /if \[\[ "\$\{PUBLISHED_FRESH\}" == "true" \]\]; then[\s\S]*PUBLISHED_IMAGE_ID[\s\S]*EXPECTED_IMAGE_ID[\s\S]*fi[\s\S]*ensure_immutable_alias "\$\{RELEASE_IMAGE\}" "\$\{AUTHORITATIVE_DIGEST\}"[\s\S]*ensure_immutable_alias "\$\{SOURCE_IMAGE\}" "\$\{AUTHORITATIVE_DIGEST\}"/
  );
  const authoritativeIndex = publisher.indexOf(
    'AUTHORITATIVE_DIGEST="${RELEASE_DIGEST:-${SOURCE_DIGEST}}"'
  );
  const freshIdentityGateIndex = publisher.indexOf('if [[ "${PUBLISHED_FRESH}" == "true" ]]');
  const receiptEvidenceIndex = publisher.indexOf(
    'verify_receipt_attestation "${AUTHORITATIVE_CONFIG_DIGEST}"'
  );
  const immutableAliasIndex = publisher.indexOf(
    'ensure_immutable_alias "${RELEASE_IMAGE}" "${AUTHORITATIVE_DIGEST}"'
  );
  assert.ok(
    0 <= authoritativeIndex &&
      authoritativeIndex < receiptEvidenceIndex &&
      receiptEvidenceIndex < freshIdentityGateIndex &&
      authoritativeIndex < freshIdentityGateIndex &&
      freshIdentityGateIndex < immutableAliasIndex
  );
  const authoritativeReceiptBlock = publisher.slice(authoritativeIndex, freshIdentityGateIndex);
  assert.match(authoritativeReceiptBlock, /config_digest_for_manifest "\$\{AUTHORITATIVE_DIGEST\}"/);
  assert.match(authoritativeReceiptBlock, /verify_receipt_attestation "\$\{AUTHORITATIVE_CONFIG_DIGEST\}"/);
  const freshIdentityBlock = publisher.slice(freshIdentityGateIndex, immutableAliasIndex);
  assert.match(freshIdentityBlock, /docker pull "\$\{GHCR_IMAGE\}@\$\{AUTHORITATIVE_DIGEST\}"/);
  assert.match(freshIdentityBlock, /PUBLISHED_IMAGE_ID[\s\S]*EXPECTED_IMAGE_ID/);
  assert.equal([...freshIdentityBlock.matchAll(/docker pull/g)].length, 1);
  assert.match(
    publisher,
    /if \[\[ -n "\$\{RELEASE_DIGEST\}" && -n "\$\{SOURCE_DIGEST\}" &&[\s\S]*"\$\{RELEASE_DIGEST\}" != "\$\{SOURCE_DIGEST\}" \]\]; then[\s\S]*Immutable image tags disagree/
  );
  assert.match(
    publisher,
    /--format '\{\{\.Manifest\.Digest\}\}' "\$\{image_ref\}"[\s\S]*repository="\$\{image_ref%:\*\}"[\s\S]*digest_ref="\$\{repository\}@\$\{digest\}"[\s\S]*imagetools inspect --raw "\$\{digest_ref\}"[\s\S]*--format '\{\{json \.Image\}\}' "\$\{digest_ref\}"/
  );
  assert.match(
    publisher,
    /verify_receipt_attestation\(\)[\s\S]*ghcr-release-receipt\.mjs create[\s\S]*--image-config-digest "\$\{config_digest\}"[\s\S]*attestation verify "\$\{receipt_file\}"[\s\S]*--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/container\.yml"[\s\S]*--source-ref refs\/heads\/master[\s\S]*--limit 100[\s\S]*--format json > "\$\{discovery_file\}"[\s\S]*ghcr-release-receipt\.mjs discover-workflows[\s\S]*--verification-file "\$\{discovery_file\}"[\s\S]*while IFS= read -r signer_revision[\s\S]*ghcr-release-receipt\.mjs authorize-workflow[\s\S]*--candidate-workflow-revision "\$\{signer_revision\}"[\s\S]*--current-workflow-revision "\$\{WORKFLOW_SHA\}"[\s\S]*--trusted-master-commit "\$\{trusted_master\}"[\s\S]*--release-commit "\$\{RELEASE_COMMIT\}"[\s\S]*attestation verify "\$\{receipt_file\}"[\s\S]*--signer-digest "\$\{signer_revision\}"[\s\S]*--source-digest "\$\{signer_revision\}"[\s\S]*--limit 100/
  );
  assert.match(
    publisher,
    /Recheck current protected workflow authority immediately before GHCR authentication[\s\S]*verify-current-release-workflow[\s\S]*TRUST_SET_COMMIT=.*refs\/remotes\/origin\/master[\s\S]*release-image-attestation-trusted-workflow-shas[\s\S]*ghcr-release-receipt\.mjs trusted-workflows[\s\S]*--current-workflow-revision "\$\{WORKFLOW_SHA\}"/
  );
  assert.match(publisher, /TRUSTED_MASTER_FILE[\s\S]*printf '%s\\n' "\$\{TRUST_SET_COMMIT\}"/);
  assert.equal(
    [...publisher.matchAll(/attestation verify/g)].length,
    [...publisher.matchAll(/--limit 100/g)].length,
    'every receipt lookup must raise the bounded attestation search limit'
  );
  assert.match(publisher, /lacks the exact trusted release receipt attestation/);
  assert.match(publisher, /Quarantine or delete its v\*\/sha-\* aliases after an owner review/);
  assert.ok(
    receiptEvidenceIndex < publisher.indexOf('ensure_immutable_alias "${RELEASE_IMAGE}"') &&
      receiptEvidenceIndex < publisher.indexOf('--tag "${LATEST_IMAGE}"'),
    'an exact registry-config receipt attestation must authorize every alias fill and latest mutation'
  );
  assert.match(publisher, /verify_release false[\s\S]*docker push "\$\{RELEASE_IMAGE\}"/);
  assert.match(publisher, /verify_release false[\s\S]*docker buildx imagetools create/);
  assert.match(publisher, /verify_release true[\s\S]*--tag "\$\{LATEST_IMAGE\}"[\s\S]*"\$\{GHCR_IMAGE\}@\$\{AUTHORITATIVE_DIGEST\}"/);
  assert.equal((publisher.match(/LATEST_DIGEST="\$\(inspect_reference_digest "\$\{LATEST_IMAGE\}"\)"/g) ?? []).length, 2);
  assert.doesNotMatch(publisher, /(?:RELEASE|SOURCE)_DIGEST="\$\(inspect_reference_digest/);
  assert.match(publisher, /require_digest "\$\{LATEST_IMAGE\}" "\$\{AUTHORITATIVE_DIGEST\}"/);

  assert.match(ghcrPolicy, /application\/vnd\.oci\.image\.index\.v1\+json/);
  assert.match(ghcrPolicy, /application\/vnd\.docker\.distribution\.manifest\.list\.v2\+json/);
  assert.match(ghcrPolicy, /imageConfig\.os !== 'linux' \|\| imageConfig\.architecture !== 'amd64'/);
  assert.match(ghcrPolicy, /configDigest: config\.digest/);
  assert.match(ghcrPolicy, /\^ERROR: \$\{escapedRef\}: \(\?:not found\|manifest unknown\)\$/);
  assert.match(packageConfig.scripts['test:release'], /ghcr-release-policy\.test\.mjs/);
  assert.match(packageConfig.scripts['test:release'], /ghcr-release-receipt\.test\.mjs/);
  for (const field of ['repository', 'ghcr_image', 'release_tag', 'release_commit', 'image_config_digest']) {
    assert.match(ghcrReceipt, new RegExp(field));
  }
  assert.doesNotMatch(ghcrReceipt, /workflow_revision|workflowRevision/);
  assert.match(ghcrReceipt, /parseGhcrAttestationWorkflowCandidates/);
  assert.match(ghcrReceipt, /authorizeGhcrReleaseWorkflow/);
  assert.match(ghcrReceipt, /unchanged-critical-tooling/);
  assert.match(ghcrReceipt, /canonical-cut-parent/);
  assert.match(ghcrReceipt, /explicitly revoked by current protected master/);
  assert.match(releaseCompatibility, /allow FULL_SHA[\s\S]*revoke FULL_SHA/);
  assert.match(releaseCompatibility, /full supported[\s\S]*recovery window/);
  assert.match(releaseCompatibility, /integrity authority, not an availability boundary/);
  assert.match(releaseCompatibility, /flood or delete records/);
  assert.match(releaseCompatibility, /Missing, deleted, or invalid legitimate receipt evidence therefore fails closed/);
  assert.match(agentGuide, /revoke SHA[\s\S]*overrides every\s+automatic rule/);
  assert.match(agentGuide, /missing\/deleted\/flooded legitimate evidence still fails closed/);

  const attestationCallChain = [
    ['container-handler.yml', 'run_release', '.github/workflows/container.yml'],
    ['publish-release-handler.yml', 'run_release', '.github/workflows/publish-release.yml'],
    ['cut-release-handler.yml', 'run_release', '.github/workflows/cut-release.yml'],
    ['publish-release.yml', 'build_release_image', '.github/workflows/container.yml'],
    ['cut-release.yml', 'publish', '.github/workflows/release-components.yml']
  ];
  for (const [workflowName, jobName, calledWorkflow] of attestationCallChain) {
    const caller = readWorkflow(workflowName);
    const header = caller.slice(0, caller.indexOf('\njobs:'));
    const callJob = workflowJobBlock(caller, jobName);
    assert.match(header, /permissions:[\s\S]*attestations: write[\s\S]*id-token: write/);
    assert.match(callJob, new RegExp(`uses: \\.\\/${calledWorkflow.replaceAll('.', '\\.')}`));
    assert.match(callJob, /permissions:[\s\S]*attestations: write[\s\S]*contents: (?:read|write)[\s\S]*id-token: write/);
  }
  for (const handlerName of ['container-handler.yml', 'publish-release-handler.yml', 'cut-release-handler.yml']) {
    const verifier = workflowJobBlock(readWorkflow(handlerName), 'verify_request');
    assert.match(verifier, /permissions:[\s\S]*actions: read[\s\S]*contents: read/);
    assert.doesNotMatch(verifier, /attestations: write|id-token: write/);
  }
  for (const [workflowName, readOnlyJobs] of [
    ['container.yml', ['build_image', 'publish_image']],
    ['publish-release.yml', ['tag_release', 'publish_release_tag', 'verify_published_release']],
    ['cut-release.yml', ['prepare', 'publish_candidate', 'release-validation', 'finalize', 'inspect_cleanup', 'cleanup-candidate']]
  ]) {
    const calledWorkflow = readWorkflow(workflowName);
    for (const jobName of readOnlyJobs) {
      assert.doesNotMatch(
        workflowJobBlock(calledWorkflow, jobName),
        /attestations: write|id-token: write/,
        `${workflowName} ${jobName} must not inherit receipt-signing authority`
      );
    }
  }

  assert.doesNotMatch(workflow, /image=moby\/buildkit:(?:latest|buildx-stable-1|master)/);
  assert.match(workflow, /ghcr\.io/);
  assert.doesNotMatch(workflow, /linux\/arm64|setup-qemu-action/);
  assert.doesNotMatch(workflow, /aws-actions|amazon-ecs|\bECR\b|\bECS\b|Deploy Staging|Deploy Prod/i);
  assert.match(deployEnvironment, /^APP_IMAGE=ghcr\.io\/mchartier\/calibratehealth:latest$/m);
  assert.doesNotMatch(deployEnvironment, /calibratehealth:master/);
});

test('no active workflow deploys to AWS or builds an image for every merged PR', () => {
  assert.equal(existsSync(path.join(workflowsDirectory, 'ghcr-master-merge.yml')), false);

  const workflows = readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => readWorkflow(name))
    .join('\n');
  assert.doesNotMatch(workflows, /aws-actions|amazon-ecs|\bECR\b|\bECS\b/i);
  assert.doesNotMatch(workflows, /pull_request_target/);
});

test('active workflows and package scripts do not retain the hosted-result or external-launch ledger', () => {
  const workflows = readdirSync(workflowsDirectory)
    .filter((entry) => entry.endsWith('.yml'))
    .map((entry) => readWorkflow(entry))
    .join('\n');
  const packageConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const acceptanceScript = readFileSync(
    path.join(repositoryRoot, 'scripts', 'release-acceptance.mjs'),
    'utf8'
  );
  const plan = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'quality', 'release-acceptance-plan.json'), 'utf8')
  );

  assert.doesNotMatch(
    workflows,
    /release-acceptance\.mjs hosted-result|\n {2}external-launch:|releaseAcceptanceEvidence|evidence_commit/
  );
  assert.equal(packageConfig.scripts['release:acceptance:external'], undefined);
  assert.equal(packageConfig.scripts['test:risk-evidence:release'], undefined);
  assert.doesNotMatch(
    acceptanceScript,
    /hosted-result|external-launch|releaseAcceptanceEvidence|evidence_commit|receipt ledger/i
  );
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.profile, 'single-user-pre-release');
  assert.equal(plan.policy.retainedEvidenceRequired, false);
  assert.ok(Array.isArray(plan.automaticRequirements));
  assert.ok(Array.isArray(plan.manualCapabilities));
  assert.doesNotMatch(
    JSON.stringify(plan),
    /retainedArtifact|external-launch|releaseAcceptanceEvidence|evidence_commit|operatorReceipt/
  );
});

test('hidden workflow evidence paths are explicitly included in artifact uploads', () => {
  for (const name of readdirSync(workflowsDirectory).filter((entry) => entry.endsWith('.yml'))) {
    const workflow = readWorkflow(name);
    const uploadSteps = workflow
      .split(/\n(?=\s+- name:)/)
      .filter((step) => step.includes('uses: actions/upload-artifact@v4'));
    for (const step of uploadSteps.filter((candidate) => candidate.includes('path: .codex-screenshots'))) {
      assert.match(step, /include-hidden-files: true/, `${name} must include its hidden evidence path`);
    }
  }
});

// Unified OTA/native authority and recovery contracts are exercised in unified-release-workflow.test.mjs.

test('pull request test suites run only for their affected surfaces', () => {
  const workflow = readWorkflow('tests.yml');
  const lintWorkflow = readWorkflow('lint.yml');
  const packageConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const changes = workflowJobBlock(workflow, 'changes');
  const backendPaths = workflowPathFilterBlock(changes, 'backend');
  const mobilePaths = workflowPathFilterBlock(changes, 'mobile');
  const backend = workflowJobBlock(workflow, 'backend-tests');
  const mobile = workflowJobBlock(workflow, 'mobile-tests');

  assertPathFilterOutputs(changes, ['backend', 'mobile'], 'decision');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(changes, /if: inputs\.release_sha == '' && github\.event_name == 'pull_request'/);
  assert.match(changes, /github\.event_name != 'pull_request'/);
  assert.match(backendPaths, /- '\.github\/workflows\/tests\.yml'/);
  assert.match(mobilePaths, /- '\.github\/workflows\/tests\.yml'/);
  assert.match(backendPaths, /- 'backend\/\*\*'/);
  assert.match(backendPaths, /- 'docs\/openapi\/v1\.yaml'/);
  assert.match(backendPaths, /- 'docs\/weight-trend-v2-tuning-report\.json'/);
  assert.match(backendPaths, /- 'shared\/\*\*'/);
  assert.match(mobilePaths, /- 'backend\/package-lock\.json'/);
  assert.match(mobilePaths, /- 'backend\/package\.json'/);
  assert.match(mobilePaths, /- 'docs\/openapi\/v1\.yaml'/);
  assert.match(mobilePaths, /- 'mobile\/\*\*'/);
  assert.match(mobilePaths, /- 'packages\/api-client\/\*\*'/);
  assert.match(mobilePaths, /- 'package\.json'/);
  assert.equal(
    packageConfig.scripts['api:generate'],
    'node backend/node_modules/openapi-typescript/bin/cli.js docs/openapi/v1.yaml -o packages/api-client/src/generated/v1.ts'
  );
  assert.equal(
    packageConfig.scripts['api:contract:check'],
    'npm run api:generate && git diff --exit-code -- packages/api-client/src/generated/v1.ts'
  );
  assert.match(backend, /needs: changes/);
  assert.match(backend, /if: needs\.changes\.outputs\.backend == 'true'/);
  assert.match(mobile, /needs: changes/);
  assert.match(mobile, /if: needs\.changes\.outputs\.mobile == 'true'/);
  assert.match(mobile, /npm run test:api-client/);
  assert.match(mobile, /npm --prefix mobile test/);
  // Required checks must report a result even for docs-only pull requests.
  assert.match(lintWorkflow, / {2}pull_request:\s+workflow_dispatch:/);
  assert.doesNotMatch(lintWorkflow, /\bpaths(?:-ignore)?:/);

  const filters = ['backend', 'mobile'];
  for (const [candidatePath, expectedFilters] of [
    ['.github/workflows/tests.yml', ['backend', 'mobile']],
    ['backend/src/routes/user.ts', ['backend']],
    ['backend/package.json', ['backend', 'mobile']],
    ['backend/package-lock.json', ['backend', 'mobile']],
    ['shared/caloriePolicy.ts', ['backend', 'mobile']],
    ['mobile/src/components/AppCard.tsx', ['mobile']],
    ['docs/openapi/v1.yaml', ['backend', 'mobile']],
    ['docs/weight-trend-v2-tuning-report.json', ['backend']],
    ['package.json', ['mobile']],
    ['docs/review-notes.md', []]
  ]) {
    const actualFilters = filters.filter((filterName) => pathFilterMatches(changes, filterName, candidatePath));
    assert.deepEqual(actualFilters, expectedFilters, candidatePath);
  }
});

test('database upgrade and rollback select only their affected database surfaces', () => {
  const workflow = readWorkflow('database-upgrade.yml');
  const packageConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const backendPackageConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'backend', 'package.json'), 'utf8'));
  const changes = workflowJobBlock(workflow, 'changes');
  const databasePaths = workflowPathFilterBlock(changes, 'database');
  const migrationPaths = workflowPathFilterBlock(changes, 'migrations');
  const populated = workflowJobBlock(workflow, 'populated-upgrade');
  const rollback = workflowJobBlock(workflow, 'release-upgrade-rollback');

  assertPathFilterOutputs(changes, ['database', 'migrations'], 'decision');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(changes, /if: inputs\.release_sha == '' && github\.event_name == 'pull_request'/);
  assert.match(changes, /github\.event_name != 'pull_request'/);
  for (const expectedPath of [
    '.github/workflows/database-upgrade.yml',
    'backend/package.json',
    'backend/package-lock.json',
    'backend/prisma.config.ts',
    'backend/prisma/**',
    'backend/src/config/database.ts',
    'backend/src/services/materializedWeightTrend.ts',
    'deploy/backup/**',
    'scripts/postgres-*.mjs',
    'shared/weightTrend*.ts'
  ]) {
    assert.ok(databasePaths.includes(`- '${expectedPath}'`), `database filter must include ${expectedPath}`);
  }
  for (const expectedPath of [
    '.github/workflows/database-upgrade.yml',
    'backend/prisma/migrations/**',
    'scripts/postgres-rollback-smoke.mjs',
    'scripts/postgres-rollback-smoke.test.mjs'
  ]) {
    assert.ok(migrationPaths.includes(`- '${expectedPath}'`), `migration filter must include ${expectedPath}`);
  }
  assert.doesNotMatch(databasePaths, /- 'package\.json'|release-acceptance/);
  assert.equal(packageConfig.scripts['prisma:generate'], 'npm --prefix backend run prisma:generate');
  assert.equal(backendPackageConfig.scripts['prisma:generate'], 'prisma generate');
  assert.equal(packageConfig.scripts['test:db:rollback:unit'], 'node --test scripts/postgres-rollback-smoke.test.mjs');
  assert.equal(packageConfig.scripts['test:db:rollback'], 'node scripts/postgres-rollback-smoke.mjs');

  for (const source of ['routes/user.ts', 'routes/goals.ts', 'routes/metrics.ts', 'routes/imports.ts',
    'services/caloriePlanningLock.ts', 'services/goalPace.ts', 'services/watch.ts', 'services/clientOperation.ts']) {
    assert.equal(pathFilterMatches(changes, 'database', `backend/src/${source}`), true, source);
    assert.equal(pathFilterMatches(changes, 'migrations', `backend/src/${source}`), false, source);
  }
  assert.equal(pathFilterMatches(changes, 'database', 'backend/prisma/schema.prisma'), true);
  assert.equal(pathFilterMatches(changes, 'migrations', 'backend/prisma/schema.prisma'), false);
  assert.equal(pathFilterMatches(changes, 'migrations', 'backend/prisma/migrations/0021/example.sql'), true);
  assert.equal(pathFilterMatches(changes, 'migrations', 'scripts/postgres-rollback-smoke.mjs'), true);
  assert.match(populated, /if: needs\.changes\.outputs\.database == 'true'/);
  assert.match(rollback, /if: needs\.changes\.outputs\.migrations == 'true'/);
  assert.doesNotMatch(workflow, /release-acceptance\.mjs hosted-result|upload-artifact/);
});

test('database rollback binds a full candidate SHA for pull requests and manual dispatches', () => {
  const rollback = workflowJobBlock(readWorkflow('database-upgrade.yml'), 'release-upgrade-rollback');
  const candidateExpression = '${{ github.event.pull_request.head.sha || github.sha }}';

  assert.ok(
    rollback.includes(`CALIBRATE_SOURCE_COMMIT: ${candidateExpression}`),
    'database rollback must fall back to github.sha when pull-request context is unavailable'
  );

  for (const scenario of [
    {
      eventName: 'pull_request',
      pullRequestHeadSha: '1'.repeat(40),
      githubSha: '2'.repeat(40),
      expected: '1'.repeat(40)
    },
    {
      eventName: 'workflow_dispatch',
      pullRequestHeadSha: '',
      githubSha: '3'.repeat(40),
      expected: '3'.repeat(40)
    }
  ]) {
    const sourceCommit = scenario.pullRequestHeadSha || scenario.githubSha;
    assert.equal(sourceCommit, scenario.expected, scenario.eventName);
    assert.match(sourceCommit, /^[0-9a-f]{40}$/, `${scenario.eventName} source SHA`);
  }
});

test('dependency audit runs all workspaces only during scheduled or manual maintenance', () => {
  const workflow = readWorkflow('dependency-audit.yml');
  const audit = workflowJobBlock(workflow, 'production-audit');
  const triggers = workflow.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1];

  assert.ok(triggers);
  assert.deepEqual(
    [...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map(([, event]) => event).sort(),
    ['schedule', 'workflow_dispatch']
  );
  assert.match(triggers, /cron: '30 13 \* \* 1'/);
  assert.doesNotMatch(workflow, /pull_request|merge_group|\n {2}changes:|paths-filter|needs:/);
  assert.deepEqual(workflowPermissions(workflow, 0), { contents: 'read' });
  assert.match(audit, /fail-fast: false/);
  assert.match(audit, /workspace: Root and Mobile\n\s+directory: \.\n\s+node: '22\.13\.0'\n\s+audit_args: '--omit=dev'/);
  assert.match(audit, /workspace: Backend\n\s+directory: backend\n\s+node: '20'\n\s+audit_args: '--omit=dev'/);
  assert.match(audit, /workspace: Locked EAS CLI\n\s+directory: tools\/eas-cli\n\s+node: '22\.14\.0'\n\s+audit_args: ''/);
  assert.match(audit, /npm audit --package-lock-only --audit-level=high \$\{\{ matrix\.audit_args \}\}/);
  assert.match(audit, /working-directory: \$\{\{ matrix\.directory \}\}/);
  assert.doesNotMatch(audit, /npm ci|continue-on-error|\|\| true|dependency-advisory-exceptions/);
  assert.match(
    audit,
    /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\.4\.0[\s\S]*ref: \$\{\{ github\.sha \}\}[\s\S]*persist-credentials: false/
  );
  assert.match(audit, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\.4\.0/);
});

test('release configuration and PR workflows do not gate merges on package advisories', () => {
  const packageConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(packageConfig.scripts)) {
    if (!name.startsWith('release:check')) continue;
    assert.doesNotMatch(command, /audit|dependency-advisory/, `${name} must only validate release configuration`);
  }
  for (const file of readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = readWorkflow(file);
    if (!/^ {2}(?:pull_request|pull_request_target|push|merge_group):/m.test(workflow)) continue;
    assert.doesNotMatch(
      workflow,
      /npm(?:\.cmd)?(?: --prefix \S+)? audit\b|npm(?:\.cmd)? run audit:|dependency-advisory-exceptions/,
      `${file} must keep package audits in scheduled/manual maintenance`
    );
  }
  assert.equal(packageConfig.scripts['audit:production'], 'npm audit --package-lock-only --omit=dev --audit-level=high');
  assert.equal(
    packageConfig.scripts['audit:eas-cli:high'],
    'npm audit --prefix tools/eas-cli --package-lock-only --audit-level=high'
  );
  assert.equal(packageConfig.scripts['audit:exceptions:check'], undefined);
});

test('container scan targets production-image inputs while preserving scheduled coverage', () => {
  const workflow = readWorkflow('container-scan.yml');
  const changes = workflowJobBlock(workflow, 'changes');
  const imagePaths = workflowPathFilterBlock(changes, 'image');
  const scan = workflowJobBlock(workflow, 'scan');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:/);
  assert.match(changes, /pull-requests: read/);
  assert.match(changes, /if: inputs\.release_sha == '' && github\.event_name == 'pull_request'/);
  assert.match(changes, /github\.event_name != 'pull_request'/);
  for (const expectedPath of [
    '.github/workflows/container-scan.yml',
    '.dockerignore',
    'Dockerfile.app',
    'backend/**',
    'mobile/**',
    'scripts/expo-cli-environment.mjs',
    'scripts/production-container-smoke.mjs'
  ]) {
    assert.ok(imagePaths.includes(`- '${expectedPath}'`), `image filter must include ${expectedPath}`);
  }
  assert.equal(pathFilterMatches(changes, 'image', '.github/workflows/container-scan.yml'), true);
  assert.match(scan, /needs: changes/);
  assert.match(scan, /if: needs\.changes\.outputs\.scan == 'true'/);
  assert.match(scan, /docker build --file Dockerfile\.app --tag calibrate:security-scan \./);
  assert.match(scan, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/readyz/);
  assert.match(scan, /npm run test:container:web -- http:\/\/127\.0\.0\.1:3000/);
  assert.match(scan, /uses: aquasecurity\/trivy-action@[0-9a-f]{40}/);
  assert.match(scan, /severity: HIGH,CRITICAL/);
  assert.ok(scan.includes(
    "vuln-type: ${{ (inputs.release_sha == '' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')) && 'os,library' || 'os' }}"
  ), 'only scheduled/manual scans may gate on package libraries; PR/push/merge scans keep OS checks');
  assert.match(scan, /ignore-unfixed: false/);
  assert.match(scan, /exit-code: '1'/);
  assert.doesNotMatch(imagePaths, /release-acceptance/);
  assert.doesNotMatch(workflow, /release-acceptance\.mjs hosted-result|upload-artifact|retention-days:/);
});

test('version-only release PRs validate mirrors without platform build fan-out', () => {
  const preparedReleasePaths = [
    'backend/package-lock.json',
    'backend/package.json',
    'docs/openapi/v1.yaml',
    'package-lock.json',
    'package.json',
    'packages/api-client/src/generated/v1.ts',
    'shared/client-diagnostic-versions.json',
    'shared/release.json'
  ];
  const workflow = readWorkflow('builds.yml');
  const changes = workflowJobBlock(workflow, 'changes');
  assert.match(changes, /id: release_mirror_filter[\s\S]*predicate-quantifier: every/);
  assert.match(
    changes,
    /NON_RELEASE_MIRROR_CHANGED: \$\{\{ steps\.release_mirror_filter\.outputs\.non_release_mirror == 'true' \}\}/
  );

  for (const candidatePath of preparedReleasePaths) {
    assert.equal(
      pathFilterMatches(changes, 'release_config', candidatePath),
      true,
      `${candidatePath} must validate release mirrors`
    );
    assert.equal(
      pathFilterMatches(changes, 'non_release_mirror', candidatePath, 'every'),
      false,
      `${candidatePath} must be recognized as a version-only mirror`
    );
  }
  assert.equal(pathFilterMatches(changes, 'non_release_mirror', 'mobile/src/App.tsx', 'every'), true);
  assert.match(changes, /HEAD_REF: \$\{\{ github\.head_ref \}\}/);
  assert.match(changes, /HEAD_REF.*release\/v\*/s);
  assert.match(changes, /NON_RELEASE_MIRROR_CHANGED.*!= "true"/s);
  assert.match(changes, /platform build fan-out is intentionally suppressed/);

  const releaseConfig = workflowJobBlock(workflow, 'release-config');
  assert.match(releaseConfig, /if: needs\.changes\.outputs\.release_config == 'true'/);
  for (const jobId of [
    'backend-build',
    'expo-web-build',
    'web-critical-smoke',
    'native-metro-bundle',
    'mobile-build',
    'ios-build',
    'wear-build'
  ]) {
    const job = workflowJobBlock(workflow, jobId);
    assert.match(job, /needs\.changes\.outputs\.(backend|web|native_runtime|native_package|wear)/);
  }

  const plan = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'quality', 'release-acceptance-plan.json'), 'utf8')
  );
  const affectedBuilds = plan.automaticRequirements.find(
    (requirement) => requirement.id === 'affected-builds'
  );
  assert.ok(affectedBuilds);
  assert.ok(affectedBuilds.jobIds.includes('web-critical-smoke'));
  assert.ok(affectedBuilds.jobIds.includes('ios-build'));
  assert.equal(plan.policy.pullRequestChecks, 'affected-only');
});

test('all pull-request workflow checkouts freeze exact candidate C', () => {
  const checkoutExpression = 'ref: ${{ inputs.release_sha || github.event.pull_request.head.sha || github.sha }}';
  for (const name of [
    'builds.yml',
    'tests.yml',
    'lint.yml',
    'database-upgrade.yml',
    'container-scan.yml'
  ]) {
    const workflow = readWorkflow(name);
    const checkoutCount = (workflow.match(/uses: actions\/checkout@(?:v4|[0-9a-f]{40})/g) ?? []).length;
    const pinnedCount = workflow.split(checkoutExpression).length - 1 + workflow.split('ref: ${{ inputs.release_sha }}').length - 1;
    assert.ok(checkoutCount > 0, `${name} must contain a checkout`);
    assert.equal(pinnedCount, checkoutCount, `${name} must pin every checkout to candidate C`);
  }
});

test('the lean acceptance plan separates automatic critical smoke from exhaustive Web suites', () => {
  const workflow = readWorkflow('builds.yml');
  const plan = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'quality', 'release-acceptance-plan.json'), 'utf8')
  );
  const affectedBuilds = plan.automaticRequirements.find(
    (requirement) => requirement.id === 'affected-builds'
  );
  const exhaustiveWeb = plan.manualCapabilities.find(
    (capability) => capability.id === 'exhaustive-web-regression'
  );

  assert.ok(affectedBuilds.jobIds.includes('web-critical-smoke'));
  for (const jobId of ['exported-web-e2e', 'data-state-acceptance', 'ux-regression']) {
    assert.equal(affectedBuilds.jobIds.includes(jobId), false);
    assert.ok(exhaustiveWeb.jobIds.includes(jobId));
    assert.match(
      workflowJobBlock(workflow, jobId),
      /if: github\.event_name == 'workflow_dispatch' && needs\.changes\.outputs\.web_release == 'true'/
    );
  }
  const smoke = workflowJobBlock(workflow, 'web-critical-smoke');
  assert.match(smoke, /if: needs\.changes\.outputs\.web == 'true'/);
  assert.match(smoke, /npm\.cmd run test:expo-web:smoke/);
  assert.doesNotMatch(workflowJobBlock(workflow, 'expo-web-build'), /performance/);
});

test('manual native rehearsals retain only short-lived diagnostic artifacts', () => {
  const workflow = readWorkflow('builds.yml');
  const plan = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'quality', 'release-acceptance-plan.json'), 'utf8')
  );
  const nativeCapability = plan.manualCapabilities.find(
    (capability) => capability.id === 'native-emulator-and-upgrade'
  );
  const expectedJobs = [
    ['android-emulator-e2e', 'android-emulator-e2e-', 'android.json'],
    ['wear-release-emulator-smoke', 'wear-release-emulator-smoke-', 'wear.json'],
    ['native-package-upgrade', 'native-package-upgrade-', 'upgrade.json']
  ];

  assert.deepEqual(
    nativeCapability.jobIds,
    expectedJobs.map(([jobId]) => jobId)
  );
  for (const [jobId, artifactPrefix, output] of expectedJobs) {
    const job = workflowJobBlock(workflow, jobId);
    assert.match(job, /github\.event_name == 'workflow_dispatch'/);
    assert.match(job, new RegExp(`name: ${artifactPrefix}\\$\\{\\{ github\\.run_id \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}`));
    assert.match(job, new RegExp(`path: \\.codex-screenshots/native-hosted/${output}`));
    assert.match(job, /include-hidden-files: true/);
    assert.match(job, /retention-days: 7/);
    assert.doesNotMatch(job, /hosted-result|acceptance-summary|--gate |retention-days: 90/);
  }
});

test('PR rollback owns migration safety without a redundant Cut release replay', () => {
  const pullRequestWorkflow = readWorkflow('database-upgrade.yml');
  const pullRequest = workflowJobBlock(pullRequestWorkflow, 'release-upgrade-rollback');
  const release = readWorkflow('cut-release.yml');
  const releaseFinalize = workflowJobBlock(release, 'finalize');

  assert.match(pullRequest, /if: needs\.changes\.outputs\.migrations == 'true'/);
  assert.match(pullRequest, /fetch-depth: 0/);
  assert.match(
    pullRequest,
    /CALIBRATE_SOURCE_COMMIT: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/
  );
  assert.match(pullRequest, /npm run test:db:rollback:unit/);
  assert.match(pullRequest, /npm run test:db:rollback/);
  assert.doesNotMatch(pullRequest, /upload-artifact|hosted-result|retention-days:/);
  assert.doesNotMatch(release, /\n {2}database-rollback:|database_migrations_changed|test:db:rollback/);
  assert.match(releaseFinalize, /needs: \[prepare, publish_candidate, release-validation, candidate-lint, candidate-tests, candidate-builds, candidate-container-scan, candidate-database-upgrade\]/);
  assert.doesNotMatch(releaseFinalize, /ux-regression/);
});

test('Optional Release Confidence is a manual owner-discretion exact-candidate check', () => {
  const workflow = readWorkflow('release-acceptance.yml');
  const owner = workflowJobBlock(workflow, 'owner-confidence');
  const plan = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'quality', 'release-acceptance-plan.json'), 'utf8')
  );
  const ownerCapability = plan.manualCapabilities.find(
    (capability) => capability.id === 'owner-release-confidence'
  );

  assert.match(workflow, /^name: Optional Release Confidence/m);
  assert.match(workflow, /workflow_dispatch:[\s\S]*candidate_commit:[\s\S]*required: true/);
  assert.doesNotMatch(workflow, /\n\s+pull_request:|\n\s+push:|\n\s+schedule:/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(owner, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(owner, /ref: \$\{\{ inputs\.candidate_commit \}\}/);
  assert.match(owner, /test "\$\(git rev-parse HEAD\)" = "\$\{CANDIDATE_COMMIT\}"/);
  assert.match(owner, /node scripts\/release-config\.mjs check/);
  assert.match(owner, /npm run audit:production/);
  assert.match(owner, /npm run test:deploy/);
  assert.match(owner, /npm run api:contract:check/);
  assert.match(owner, /git diff --exit-code/);
  assert.doesNotMatch(
    workflow,
    /external-launch|evidence_commit|release:acceptance:external|test:risk-evidence:release|hosted-result|upload-artifact|Playwright|emulator/i
  );
  assert.deepEqual(ownerCapability.jobIds, ['owner-confidence']);
  assert.equal(plan.policy.externalReleaseApproval, 'owner-discretion');
  assert.equal(plan.policy.retainedEvidenceRequired, false);
});
