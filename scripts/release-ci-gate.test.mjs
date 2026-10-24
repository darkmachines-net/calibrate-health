/** Validate exact-candidate CI identities and protected merge sequencing. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { REQUIRED_CI, assertCandidateInputs, assertIdentity, evaluateRuns, evaluateTrustedJobs, githubApi, githubCheckWriter, inspectCi, inspectTrustedCi, publishRequiredChecks, waitForCi } from './release-ci-gate.mjs';

/** Suppress progress output in deterministic CI gate tests. */
const noReport = () => {};

const identity = { repository: 'owner/repo', head: 'a'.repeat(40), base: 'b'.repeat(40), branch: 'release/v1.2.3', number: '12' };
/** Model exact candidate identities and required CI runs without GitHub writes. */
function fixture() {
  const repo = { id: 123, full_name: identity.repository };
  const pull = { state: 'open', merged: false, draft: false,
    head: { sha: identity.head, ref: identity.branch, repo }, base: { sha: identity.base, ref: 'master', repo } };
  const master = { object: { sha: identity.base } };
  const runs = Object.entries(REQUIRED_CI).map(([file, names], index) => ({
    id: index + 1, path: `.github/workflows/${file}`, event: 'pull_request',
    head_sha: identity.head, head_branch: identity.branch, head_repository: repo,
    pull_requests: [{ number: Number(identity.number),
      head: { sha: identity.head, ref: identity.branch, repo },
      base: { sha: identity.base, ref: 'master', repo } }],
    status: 'completed', conclusion: 'success', run_attempt: 1, html_url: `https://github.com/owner/repo/actions/runs/${index + 1}`,
    jobs: names.map(name => ({ name, status: 'completed', conclusion: 'success' })),
  }));
  /** Return controlled GitHub observations for CI identity and pagination tests. */
  const api = async path => {
    if (path.includes('/pulls/')) return pull;
    if (path.endsWith('/git/ref/heads/master')) return master;
    if (path.includes('/actions/runs?')) return structuredClone(runs);
    const id = Number(path.match(/\/runs\/(\d+)/)?.[1]);
    const run = runs.find(item => item.id === id);
    if (path.includes('/jobs?')) return run.jobs;
    if (run) return run;
    throw new Error(`Unexpected request ${path}`);
  };
  return { pull, master, runs, api };
}

test('complete exact-candidate CI permits finalization, with canonical skips only', async () => {
  const f = fixture();
  f.runs[2].jobs.push({ name: 'iOS Build', status: 'completed', conclusion: 'skipped' });
  f.runs[4].jobs.push({ name: 'v0.14.0 Upgrade and Encrypted Rollback', status: 'completed', conclusion: 'skipped' });
  assert.equal((await waitForCi(f.api, identity, { report: noReport })).selected.length, 5);
});

for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required', null]) {
  test(`${conclusion} CI cannot authorize merge/publication`, async () => {
    const f = fixture();
    f.runs[0].conclusion = conclusion;
    await assert.rejects(inspectCi(f.api, identity), /lint.yml/);
  });
}

test('approval-expired zero-job failure reproduces PR432 and blocks', async () => {
  const f = fixture();
  f.runs.forEach(run => { run.conclusion = 'failure'; run.jobs = []; });
  await assert.rejects(inspectCi(f.api, identity), /approval\/no-job annotations/);
});

test('empty inventory, pending approval and missing workflows time out without a merge', async () => {
  for (const kind of ['empty', 'missing', 'waiting', 'queued', 'in_progress']) {
    const f = fixture();
    if (kind === 'empty') f.runs.length = 0;
    else if (kind === 'missing') f.runs.pop();
    else f.runs[0].status = kind;
    await assert.rejects(waitForCi(f.api, identity, { timeoutMs: 0, report: noReport }), /timed out/);
  }
});

test('polling allows approval then success and is bounded when approval never arrives', async () => {
  const f = fixture();
  f.runs[0].status = 'waiting';
  let clock = 0;
  const options = { now: () => clock, timeoutMs: 30_000, report: noReport, sleep: async ms => { clock += ms; f.runs[0].status = 'completed'; } };
  assert.equal((await waitForCi(f.api, identity, options)).selected.length, 5);
  assert.equal(clock, 15_000);
  f.runs[0].status = 'waiting';
  await assert.rejects(waitForCi(f.api, identity, { ...options, sleep: async ms => { clock += ms; } }), /timed out/);
});

test('newer failed run or rerun cannot fall back to historical green CI', async () => {
  const f = fixture();
  f.runs.push({ ...f.runs[0], id: 100, conclusion: 'failure' });
  await assert.rejects(inspectCi(f.api, identity), /failure/);
  f.runs.pop();
  await assert.rejects(inspectCi(async path => {
    const result = await f.api(path);
    return path.endsWith('/runs/1') ? { ...result, run_attempt: 2 } : result;
  }, identity), /attempt changed/);
});

test('wrong event, source, repository, branch or workflow never supplies required success', () => {
  for (const [field, value] of Object.entries({ event: 'workflow_dispatch', head_sha: 'c'.repeat(40), head_repository: { full_name: 'attacker/repo' }, head_branch: 'other', path: '.github/workflows/other.yml' })) {
    const f = fixture();
    f.runs[0][field] = value;
    assert.equal(evaluateRuns(f.runs, identity).pending.length, 1);
  }
});

test('zero jobs, missing required success, unexpected skips and failing jobs fail closed', () => {
  for (const jobs of [[], [{ name: REQUIRED_CI['lint.yml'][0], status: 'completed', conclusion: 'skipped' }],
    [...fixture().runs[0].jobs, { name: 'Unexpected', status: 'completed', conclusion: 'skipped' }],
    [...fixture().runs[0].jobs, { name: 'Unexpected', status: 'completed', conclusion: 'failure' }]]) {
    const f = fixture(); f.runs[0].jobs = jobs;
    assert.throws(() => evaluateRuns(f.runs, identity), /job/);
  }
});

test('missing lint or aggregate test success cannot authorize a release', () => {
  for (const [workflow, name] of [['lint.yml', 'ESLint (zero warnings)'], ['tests.yml', 'Required Tests']]) {
    const f = fixture();
    const run = f.runs.find(item => item.path === `.github/workflows/${workflow}`);
    run.jobs = run.jobs.filter(job => job.name !== name);
    assert.throws(() => evaluateRuns(f.runs, identity), /required job/);
  }
});

test('moved head/base/master, closed or draft PR cannot merge', () => {
  for (const mutate of [f => f.pull.head.sha = 'c'.repeat(40), f => f.pull.base.sha = 'c'.repeat(40),
    f => f.master.object.sha = 'c'.repeat(40), f => f.pull.state = 'closed', f => f.pull.draft = true,
    f => f.pull.head.ref = 'other', f => f.pull.head.repo = { full_name: 'other/repo' }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => assertIdentity(f, identity), /changed/);
  }
});

test('final one-shot inspection rejects refs moving during CI reads', async () => {
  for (const mutate of [f => f.master.object.sha = 'c'.repeat(40),
    f => f.pull.head.sha = 'c'.repeat(40), f => f.pull.base.sha = 'c'.repeat(40)]) {
    const f = fixture();
    let changed = false;
    /** Return controlled GitHub observations for CI identity and pagination tests. */
    const api = async (path, collection) => {
      const result = structuredClone(await f.api(path, collection));
      if (!changed && path.includes('/actions/runs?')) { mutate(f); changed = true; }
      return result;
    };
    await assert.rejects(waitForCi(api, identity, { timeoutMs: 0, report: noReport }), /changed/);
  }
});

test('successful runs must identify this single PR and its tested base/head', async () => {
  for (const mutate of [run => run.pull_requests = [], run => delete run.pull_requests,
    run => run.pull_requests.push(structuredClone(run.pull_requests[0])),
    run => run.pull_requests[0].number = 99,
    run => run.pull_requests[0].base.sha = 'c'.repeat(40),
    run => run.pull_requests[0].base.ref = 'other',
    run => run.pull_requests[0].head.sha = 'c'.repeat(40),
    run => run.pull_requests[0].head.ref = 'other',
    run => run.pull_requests[0].base.repo = { id: 999 },
    run => run.pull_requests[0].head.repo = { id: 999 }]) {
    const f = fixture(); mutate(f.runs[0]);
    await assert.rejects(inspectCi(f.api, identity), /PR\/base identity/);
  }
});

test('fresh run read cannot change PR binding or hide a newer mismatched run', async () => {
  const f = fixture();
  await assert.rejects(inspectCi(async path => {
    const result = structuredClone(await f.api(path));
    if (path.endsWith('/runs/1')) result.pull_requests[0].base.sha = 'c'.repeat(40);
    return result;
  }, identity), /PR\/base identity/);
  const newer = structuredClone(f.runs[0]);
  newer.id = 100; newer.pull_requests[0].number = 99; f.runs.push(newer);
  await assert.rejects(inspectCi(f.api, identity), /PR\/base identity/);
});

test('complete pagination, API denial and truncated inventory are handled explicitly', async () => {
  const responses = [{ total_count: 2, jobs: [{ id: 1 }] }, { total_count: 2, jobs: [{ id: 2 }] }];
  const urls = [];
  const api = githubApi({ token: 'synthetic', fetchImpl: async url => { urls.push(url); return { ok: true, json: async () => responses.shift() }; } });
  assert.deepEqual(await api('/jobs?per_page=100', 'jobs'), [{ id: 1 }, { id: 2 }]);
  assert.match(urls[1], /page=2$/);
  await assert.rejects(githubApi({ token: 'synthetic', fetchImpl: async () => ({ ok: false, status: 403 }) })('/jobs'), /403/);
  await assert.rejects(githubApi({ token: 'synthetic', fetchImpl: async () => ({ ok: true, json: async () => ({ total_count: 1, jobs: [] }) }) })('/jobs?per_page=100', 'jobs'), /truncated/);
});

test('workflow gates merge twice, retains blocked candidates and preserves explicit publication dependency', () => {
  const workflow = readFileSync(new URL('../.github/workflows/cut-release.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('Open or reuse the exact release pull request') < workflow.indexOf('Verify exact candidate CI from this release run'));
  assert.ok(workflow.indexOf('Verify exact candidate CI from this release run') < workflow.indexOf('Merge the exact release pull request through GitHub'));
  assert.ok(workflow.indexOf('release-ci-gate.mjs --once') < workflow.indexOf('MERGE_RESPONSE='));
  assert.match(workflow, /needs\.release-validation\.result != 'success'/);
  assert.match(workflow, /publish:\n[\s\S]*needs: \[select, reserve, prepare, finalize\]/);
  assert.match(workflow, /release_status:\n[\s\S]*if: \$\{\{ always\(\) \}\}/);
  assert.doesNotMatch(workflow, /pull_request_target|actions: write/);
  assert.equal((workflow.match(/checks: write/g) ?? []).length, 1);
  assert.match(workflow, /run: node \.release-tooling\/scripts\/release-ci-gate.mjs --publish-required-checks/);
});

/** Bind candidate jobs to a single protected originating run and workflow revision. */
function trustedFixture() {
  const f = fixture();
  const binding = { ...identity, runId: '456', runAttempt: '2' };
  const run = { id: 456, run_attempt: 2, path: '.github/workflows/cut-release-handler.yml',
    event: 'workflow_run', head_branch: 'master', head_sha: identity.base, status: 'in_progress', conclusion: null,
    repository: { full_name: identity.repository }, head_repository: { full_name: identity.repository },
    referenced_workflows: ['cut-release.yml', ...Object.keys(REQUIRED_CI)].map(file => ({
      path: `${identity.repository}/.github/workflows/${file}@refs/heads/master`, sha: identity.base })) };
  let id = 0;
  const jobs = Object.entries(REQUIRED_CI).flatMap(([file, names]) => names.map(name => ({
    id: ++id, run_id: 456, head_sha: identity.base, status: 'completed', conclusion: 'success',
    name: `Cut release / Release candidate ${file.slice(0, -4)} / ${name} [${identity.head}]` })));
  /** Return controlled GitHub observations for CI identity and pagination tests. */
  const api = async path => path.endsWith('/runs/456') ? run : path.includes('/jobs?filter=all') ? jobs : f.api(path);
  return { ...f, binding, run, jobs, api };
}

test('trusted candidate CI succeeds without any pull-request-event workflow run', async () => {
  const f = trustedFixture();
  f.runs.length = 0;
  assert.equal((await inspectTrustedCi(f.api, f.binding)).selected.length, 5);
});

test('required release checks are published on the validated candidate with links to trusted CI', async () => {
  const f = trustedFixture();
  const writes = [];
  await publishRequiredChecks(f.api, async (repository, check) => writes.push({ repository, ...check }), f.binding);
  assert.deepEqual(writes.map(check => check.name), [
    'Backend, Shared, API Client, and Mobile Typecheck', 'ESLint (zero warnings)', 'Required Tests',
  ]);
  for (const check of writes) {
    assert.equal(check.repository, identity.repository);
    assert.equal(check.head_sha, identity.head);
    assert.equal(check.conclusion, 'success');
    assert.equal(check.status, 'completed');
    assert.equal(check.external_id, `456:2:${identity.head}`);
    assert.equal(check.details_url, 'https://github.com/owner/repo/actions/runs/456/attempts/2');
  }
});

test('failed, missing, stale or untrusted CI never publishes successful required checks', async () => {
  for (const mutate of [
    f => f.jobs[0].conclusion = 'failure',
    f => f.jobs.length = 0,
    f => f.master.object.sha = identity.head,
    f => f.run.run_attempt++,
    f => delete f.binding.runId,
  ]) {
    const f = trustedFixture();
    mutate(f);
    const writes = [];
    await assert.rejects(publishRequiredChecks(f.api, async (...args) => writes.push(args), f.binding));
    assert.equal(writes.length, 0);
  }
});

test('check publication sends the exact check and rejects denied or mismatched GitHub responses', async () => {
  const check = { name: 'Required Tests', head_sha: identity.head, status: 'completed', conclusion: 'success' };
  let request;
  const writer = githubCheckWriter({ token: 'synthetic', fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ ...check, app: { slug: 'github-actions' } }) };
  } });
  await writer(identity.repository, check);
  assert.equal(request.url, 'https://api.github.com/repos/owner/repo/check-runs');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), check);
  for (const result of [
    { ok: false, status: 403 },
    ...[{ head_sha: identity.base }, { name: 'Other' }, { conclusion: 'failure' },
      { status: 'queued' }, { app: { slug: 'other' } }].map(overrides => ({
      ok: true, json: async () => ({ ...check, app: { slug: 'github-actions' }, ...overrides }),
    })),
  ]) {
    await assert.rejects(githubCheckWriter({ token: 'synthetic', fetchImpl: async () => result })(identity.repository, check));
  }
});

test('trusted CI rejects wrong run, source, event, workflow and attempt', async () => {
  for (const mutate of [run => run.id++, run => run.run_attempt++, run => run.head_sha = identity.head,
    run => run.event = 'pull_request', run => run.head_branch = 'other', run => run.status = 'completed',
    run => run.repository.full_name = 'other/repo', run => run.head_repository.full_name = 'other/repo',
    run => run.referenced_workflows.pop(), run => run.referenced_workflows[0].sha = identity.head]) {
    const f = trustedFixture(); mutate(f.run);
    await assert.rejects(inspectTrustedCi(f.api, f.binding), /identity|workflow source/);
  }
});

test('missing, all-skipped, cancelled and failed trusted validation cannot merge', async () => {
  for (const conclusion of ['skipped', 'failure', 'cancelled', 'neutral', null]) {
    const f = trustedFixture(); f.jobs.forEach(job => job.conclusion = conclusion);
    await assert.rejects(inspectTrustedCi(f.api, f.binding), /did not succeed/);
  }
  const f = trustedFixture(); f.jobs.length = 0;
  await assert.rejects(inspectTrustedCi(f.api, f.binding), /did not succeed/);
});

test('failed-job retry reuses exact-candidate successes but never an older passing job over newer failure', () => {
  const f = trustedFixture();
  assert.equal(evaluateTrustedJobs(f.jobs, f.binding).selected.length, 5);
  f.jobs.push({ ...f.jobs[0], id: 100, conclusion: 'failure' });
  assert.throws(() => evaluateTrustedJobs(f.jobs, f.binding), /did not succeed/);
  f.jobs[0].name = f.jobs[0].name.replace(identity.head, 'c'.repeat(40));
  f.jobs.pop();
  assert.throws(() => evaluateTrustedJobs(f.jobs, f.binding), /did not succeed/);
});

test('trusted jobs remain bound to this run and source and permit only named platform skips', () => {
  for (const field of ['run_id', 'head_sha']) {
    const f = trustedFixture(); f.jobs[0][field] = 'wrong';
    assert.throws(() => evaluateTrustedJobs(f.jobs, f.binding), /unacceptable/);
  }
  const f = trustedFixture();
  const skipped = { id: 100, run_id: 456, head_sha: identity.base, status: 'completed', conclusion: 'skipped',
    name: 'Cut release / Release candidate builds / iOS Build' };
  f.jobs.push(skipped);
  assert.equal(evaluateTrustedJobs(f.jobs, f.binding).selected.length, 5);
  skipped.conclusion = 'success';
  assert.throws(() => evaluateTrustedJobs(f.jobs, f.binding), /unacceptable/);
  skipped.conclusion = 'skipped';
  skipped.name = skipped.name.replace('iOS Build', 'Unrecognized');
  assert.throws(() => evaluateTrustedJobs(f.jobs, f.binding), /unacceptable/);
});

test('trusted premerge inspection rebinds the PR, master and run after inventory reads', async () => {
  for (const changed of ['master', 'attempt']) {
    const f = trustedFixture();
    await assert.rejects(inspectTrustedCi(async path => {
      const result = await f.api(path);
      if (path.includes('/jobs?')) {
        if (changed === 'master') f.master.object.sha = identity.head;
        else f.run.run_attempt++;
      }
      return result;
    }, f.binding), /changed/);
  }
});

test('reusable checkout rejects missing or mixed candidate/source/workflow inputs', () => {
  const env = { RELEASE_SHA: identity.head, SOURCE_SHA: identity.base, WORKFLOW_SHA: identity.base,
    GITHUB_SHA: identity.base, GITHUB_REF: 'refs/heads/master' };
  assertCandidateInputs(env, `${identity.head} ${identity.base}\n`);
  for (const key of Object.keys(env)) assert.throws(() => assertCandidateInputs({ ...env, [key]: '' }, `${identity.head} ${identity.base}`));
  for (const ancestry of [identity.head, `${identity.head} ${identity.base} ${identity.base}`, `${identity.head} ${'c'.repeat(40)}`]) {
    assert.throws(() => assertCandidateInputs(env, ancestry));
  }
});
