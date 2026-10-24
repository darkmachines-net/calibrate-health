import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Only canonical version-mirror candidates reach this gate. Builds intentionally
// suppresses platform fan-out; database rollback requires an actual migration.
export const REQUIRED_CI = {
  'lint.yml': ['Backend, Shared, API Client, and Mobile Typecheck', 'ESLint (zero warnings)'],
  'tests.yml': ['Classify Test Inputs', 'Backend Tests', 'Mobile Tests', 'Required Tests'],
  'builds.yml': ['Classify Build Inputs', 'Release Configuration'],
  'container-scan.yml': ['Classify Production Image Inputs', 'High and Critical Vulnerabilities'],
  'database-upgrade.yml': ['Classify Database Inputs', 'Populated Postgres Upgrade'],
};
const ALLOWED_SKIPS = {
  'builds.yml': [
    'Backend Build', 'Expo Web Build', 'Web Critical Smoke',
    'Full Exported Web and PWA End-to-End', 'Six-State Data-Backed Route Acceptance',
    'UX Accessibility and Visual Regression', '${{ matrix.platform }} Runtime Bundle',
    'Mobile Build', 'iOS Build', 'Wear Build and JVM Tests',
    'Android Emulator End-to-End', 'Wear Release Emulator Smoke', 'Native Two-Emulator Package Upgrade',
  ],
  'database-upgrade.yml': ['v0.14.0 Upgrade and Encrypted Rollback'],
};

export function assertCandidateInputs(env, ancestry) {
  const { RELEASE_SHA: head, SOURCE_SHA: source, WORKFLOW_SHA: workflow } = env;
  if (!/^[0-9a-f]{40}$/.test(head ?? '') || !/^[0-9a-f]{40}$/.test(source ?? '') ||
      head === source || workflow !== source || env.GITHUB_SHA !== source || env.GITHUB_REF !== 'refs/heads/master' ||
      ancestry.trim() !== `${head} ${source}`) {
    throw new Error('Reusable CI requires the exact candidate, sole source parent and protected workflow identity.');
  }
}

function assertTrustedRun(run, identity) {
  const expectedPath = '.github/workflows/cut-release-handler.yml';
  if (run.id !== Number(identity.runId) || run.run_attempt !== Number(identity.runAttempt) ||
      run.path !== expectedPath || run.event !== 'workflow_run' || run.head_branch !== 'master' ||
      run.head_sha !== identity.base || run.head_repository?.full_name !== identity.repository ||
      run.repository?.full_name !== identity.repository || run.status !== 'in_progress' || run.conclusion !== null) {
    throw new Error('Trusted release run identity/attempt changed; no merge permitted.');
  }
  for (const file of ['cut-release.yml', ...Object.keys(REQUIRED_CI)]) {
    const matches = (run.referenced_workflows ?? []).filter(workflow =>
      workflow.path?.split('@')[0] === `${identity.repository}/.github/workflows/${file}`);
    if (matches.length !== 1 || matches[0].sha !== identity.base) {
      throw new Error(`Trusted release run lacks the exact ${file} workflow source.`);
    }
  }
}

export function evaluateTrustedJobs(jobs, identity) {
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('Duplicate job identities in CI inventory.');
  const selected = [];
  for (const [file, required] of Object.entries(REQUIRED_CI)) {
    const prefix = `Release candidate ${file.slice(0, -4)} / `;
    // Failed-job retries reuse successful jobs from earlier attempts of this
    // same run. The explicit candidate suffix binds those jobs to their input,
    // and the newest job identity always wins over an older passing execution.
    const suffix = ` [${identity.head}]`;
    const latest = new Map();
    for (const job of [...jobs].sort((a, b) => b.id - a.id)) {
      if (!(job.name?.startsWith(prefix) || job.name?.includes(` / ${prefix}`))) continue;
      // Jobs for a different candidate in the same run cannot satisfy this gate.
      if (/ \[[0-9a-f]{40}\]$/.test(job.name) && !job.name.endsWith(suffix)) continue;
      if (!latest.has(job.name)) latest.set(job.name, job);
    }
    const own = [...latest.values()].map(job => ({ ...job,
      bound: job.name.endsWith(suffix),
      shortName: job.name.slice(job.name.indexOf(prefix) + prefix.length, job.name.endsWith(suffix) ? -suffix.length : undefined) }));
    for (const name of required) {
      const matches = own.filter(job => job.shortName === name);
      if (matches.length !== 1 || !matches[0].bound || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
        throw new Error(`${file}: required job ${name} did not succeed in this release attempt.`);
      }
    }
    for (const job of own) {
      if (!Number.isSafeInteger(job.id) || job.id <= 0 || job.run_id !== Number(identity.runId) || job.head_sha !== identity.base || job.status !== 'completed' ||
          (!(required.includes(job.shortName) && job.bound && job.conclusion === 'success') &&
          !(job.conclusion === 'skipped' && ALLOWED_SKIPS[file]?.includes(job.shortName)))) {
        throw new Error(`${file}: unacceptable candidate job ${job.name}: ${job.conclusion}.`);
      }
    }
    selected.push({ path: file, run_attempt: Number(identity.runAttempt),
      html_url: `https://github.com/${identity.repository}/actions/runs/${identity.runId}` });
  }
  return { selected, pending: [] };
}

export async function inspectTrustedCi(api, identity) {
  const root = `/repos/${identity.repository}`;
  assertIdentity({ pull: await api(`${root}/pulls/${identity.number}`), master: await api(`${root}/git/ref/heads/master`) }, identity);
  const runPath = `${root}/actions/runs/${identity.runId}`;
  assertTrustedRun(await api(runPath), identity);
  const jobs = await api(`${runPath}/jobs?filter=all&per_page=100`, 'jobs');
  const result = evaluateTrustedJobs(jobs, identity);
  assertTrustedRun(await api(runPath), identity);
  assertIdentity({ pull: await api(`${root}/pulls/${identity.number}`), master: await api(`${root}/git/ref/heads/master`) }, identity);
  return result;
}

// Bot-created release PRs do not trigger pull_request workflows. Publish only
// results already verified against this protected run and exact candidate.
export async function publishRequiredChecks(api, createCheck, identity) {
  if (!identity.runId || !identity.runAttempt) throw new Error('Required checks need a trusted release run.');
  await inspectTrustedCi(api, identity);
  for (const name of [...REQUIRED_CI['lint.yml'], 'Required Tests']) {
    await createCheck(identity.repository, {
      name,
      head_sha: identity.head,
      status: 'completed',
      conclusion: 'success',
      external_id: `${identity.runId}:${identity.runAttempt}:${identity.head}`,
      details_url: `https://github.com/${identity.repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`,
      output: {
        title: 'Exact release candidate validation passed',
        summary: `Verified ${name} for candidate ${identity.head} against protected source ${identity.base} in release run ${identity.runId}, attempt ${identity.runAttempt}.`,
      },
    });
  }
}

export function githubCheckWriter({ token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  return async (repository, check) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/check-runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify(check),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Required check publication failed (${response.status}); no merge permitted.`);
    const result = await response.json();
    if (result.name !== check.name || result.head_sha !== check.head_sha || result.status !== 'completed' ||
        result.conclusion !== 'success' || result.app?.slug !== 'github-actions') {
      throw new Error('Published check identity differs from the verified release candidate.');
    }
  };
}

export function assertIdentity({ pull, master }, identity) {
  const { repository, head, base, branch } = identity;
  if (pull.state !== 'open' || pull.merged || pull.draft ||
      pull.head?.sha !== head || pull.head?.ref !== branch ||
      pull.head?.repo?.full_name !== repository || pull.base?.repo?.full_name !== repository ||
      pull.base?.ref !== 'master' || pull.base?.sha !== base || master.object?.sha !== base) {
    throw new Error('Release PR/head/base changed; no merge permitted. Inspect the candidate before recovery.');
  }
}

function assertRunIdentity(run, identity) {
  const associated = run.pull_requests;
  const pull = associated?.[0];
  const repositoryId = run.head_repository?.id;
  if (!Array.isArray(associated) || associated.length !== 1 ||
      !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      pull?.number !== Number(identity.number) ||
      pull.head?.sha !== identity.head || pull.head?.ref !== identity.branch ||
      pull.base?.sha !== identity.base || pull.base?.ref !== 'master' ||
      pull.head?.repo?.id !== repositoryId || pull.base?.repo?.id !== repositoryId ||
      run.head_sha !== identity.head || run.head_branch !== identity.branch ||
      run.head_repository?.full_name !== identity.repository || run.event !== 'pull_request') {
    throw new Error(`CI run lacks the exact single PR/base identity: ${run.html_url}. No merge permitted.`);
  }
}

export function evaluateRuns(runs, identity) {
  const selected = [];
  const pending = [];
  for (const [file, requiredJobs] of Object.entries(REQUIRED_CI)) {
    const candidates = runs.filter(run => run.path === `.github/workflows/${file}` &&
      run.event === 'pull_request' && run.head_sha === identity.head &&
      run.head_branch === identity.branch && run.head_repository?.full_name === identity.repository);
    const run = candidates.sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== 'completed') {
      pending.push(`${file}: ${run?.status ?? 'missing'}${run ? ` (${run.html_url})` : ''}`);
      continue;
    }
    if (run.conclusion !== 'success') {
      throw new Error(`${file}: ${run.conclusion}; inspect ${run.html_url}, including approval/no-job annotations.`);
    }
    assertRunIdentity(run, identity);
    const jobs = run.jobs ?? [];
    for (const name of requiredJobs) {
      if (!jobs.some(job => job.name === name && job.status === 'completed' && job.conclusion === 'success')) {
        throw new Error(`${file}: required job ${name} did not succeed (${run.html_url}).`);
      }
    }
    for (const job of jobs) {
      if (job.status !== 'completed' || (job.conclusion !== 'success' &&
          !(job.conclusion === 'skipped' && ALLOWED_SKIPS[file]?.includes(job.name)))) {
        throw new Error(`${file}: unacceptable job ${job.name}: ${job.conclusion} (${run.html_url}).`);
      }
    }
    selected.push(run);
  }
  return { selected, pending };
}

export async function inspectCi(api, identity) {
  const root = `/repos/${identity.repository}`;
  const pull = await api(`${root}/pulls/${identity.number}`);
  const master = await api(`${root}/git/ref/heads/master`);
  assertIdentity({ pull, master }, identity);
  const runs = await api(`${root}/actions/runs?head_sha=${identity.head}&event=pull_request&per_page=100`, 'workflow_runs');
  // Never fall back to an older passing run if a newer attempt is pending/failing.
  for (const file of Object.keys(REQUIRED_CI)) {
    const latest = runs.filter(run => run.path === `.github/workflows/${file}` &&
      run.event === 'pull_request' && run.head_sha === identity.head &&
      run.head_branch === identity.branch && run.head_repository?.full_name === identity.repository)
      .sort((a, b) => b.id - a.id)[0];
    if (latest?.status === 'completed' && latest.conclusion === 'success') {
      assertRunIdentity(latest, identity);
      latest.jobs = await api(`${root}/actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs?per_page=100`, 'jobs');
      const fresh = await api(`${root}/actions/runs/${latest.id}`);
      assertRunIdentity(fresh, identity);
      if (fresh.run_attempt !== latest.run_attempt || fresh.status !== latest.status || fresh.conclusion !== latest.conclusion) {
        throw new Error(`CI attempt changed during inspection: ${latest.html_url}. Retry after CI settles.`);
      }
    }
  }
  const result = evaluateRuns(runs, identity);
  // CI inventory/attempt reads take time. Rebind refs afterward, including the
  // final --once invocation immediately before the SHA-locked merge API.
  const currentPull = await api(`${root}/pulls/${identity.number}`);
  const currentMaster = await api(`${root}/git/ref/heads/master`);
  assertIdentity({ pull: currentPull, master: currentMaster }, identity);
  return result;
}

export async function waitForCi(api, identity, {
  timeoutMs = 40 * 60_000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = console.log,
} = {}) {
  const deadline = now() + timeoutMs;
  let previousPending;
  while (true) {
    const result = await (identity.runId ? inspectTrustedCi(api, identity) : inspectCi(api, identity));
    if (!result.pending.length) {
      report(result.selected.map(run => `${run.path}: success (${run.html_url}, attempt ${run.run_attempt})`).join('\n'));
      return result;
    }
    const pendingMessage = `Waiting for release CI: ${result.pending.join('; ')}`;
    if (pendingMessage !== previousPending) report(pendingMessage);
    previousPending = pendingMessage;
    if (now() >= deadline) throw new Error('CI gate timed out. Approve/repair the exact PR checks, then rerun failed release jobs while refs remain unchanged.');
    await sleep(Math.min(15_000, deadline - now()));
  }
}

export function githubApi({ token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  return async (path, collection) => {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const response = await fetchImpl(`${apiUrl}${path}${collection ? `&page=${page}` : ''}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`GitHub CI read failed (${response.status}); no merge permitted.`);
      const data = await response.json();
      if (!collection) return data;
      if (!Array.isArray(data[collection]) || !Number.isInteger(data.total_count)) throw new Error('Incomplete GitHub CI response.');
      items.push(...data[collection]);
      if (items.length === data.total_count) return items;
      if (!data[collection].length || items.length > data.total_count) throw new Error('CI inventory changed or was truncated.');
    }
    throw new Error('CI inventory exceeds the bounded complete-read limit.');
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_REPOSITORY: repository, SOURCE_SHA: base, RELEASE_SHA: head,
    RELEASE_BRANCH: branch, PULL_REQUEST_NUMBER: number, GITHUB_TOKEN: token } = process.env;
  try {
    if (process.argv.includes('--verify-inputs')) {
      assertCandidateInputs(process.env, execFileSync('git', ['--no-replace-objects', 'rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8' }));
      console.log('Exact candidate/source/workflow identity verified.');
      process.exit(0);
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[0-9a-f]{40}$/.test(base ?? '') ||
        !/^[0-9a-f]{40}$/.test(head ?? '') || !/^release\/v\d+\.\d+\.\d+$/.test(branch ?? '') ||
        !/^[1-9]\d*$/.test(number ?? '') || !token) throw new Error('Missing exact release CI identity/token.');
    const runId = process.env.RELEASE_CI_RUN_ID;
    const runAttempt = process.env.RELEASE_CI_RUN_ATTEMPT;
    if ((runId || runAttempt) && (!/^[1-9]\d*$/.test(runId ?? '') || !/^[1-9]\d*$/.test(runAttempt ?? '') ||
        runId !== process.env.GITHUB_RUN_ID || runAttempt !== process.env.GITHUB_RUN_ATTEMPT || process.env.WORKFLOW_SHA !== base)) {
      throw new Error('Missing exact current release run/attempt/workflow identity.');
    }
    const api = githubApi({ token, apiUrl: process.env.GITHUB_API_URL });
    const identity = { repository, base, head, branch, number, runId, runAttempt };
    await waitForCi(api, identity, {
      timeoutMs: process.argv.includes('--once') ? 0 : 40 * 60_000,
      report: message => {
        console.log(message);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
      },
    });
    if (process.argv.includes('--publish-required-checks')) {
      await publishRequiredChecks(api, githubCheckWriter({ token, apiUrl: process.env.GITHUB_API_URL }), identity);
    }
  } catch (error) {
    console.error(error.message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release CI blocked: ${error.message}\n`);
    process.exitCode = 1;
  }
}
